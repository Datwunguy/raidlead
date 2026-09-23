-- ============================================================
-- Loot.lua — encounter tracking + loot capture + BoE filtering.
--
-- Two independent capture paths, since a raid's chosen loot method
-- decides which one ever actually fires -- Personal Loot and Group Loot
-- are mutually exclusive per-raid, but different runs (or a guild vs. a
-- pug) may use either, so both paths are kept live rather than picking one:
--
-- 1. Personal Loot -- via CHAT_MSG_LOOT, a long-standing, well-documented
--    chat event that fires for every raid member's loot, not just your
--    own. Solid, been in production use.
--
-- 2. Group Loot (Need/Greed roll, highest roll wins) -- via the
--    C_LootHistory API and LOOT_HISTORY_UPDATE_DROP event (see below).
--    Confirmed working against a live client: drops resolve and the
--    correct winner is captured. Still unverified: the exact
--    Enum.EncounterLootDropRollState values (assumed below: 0
--    NeedMainSpec, 1 NeedOffSpec, 2 Transmog, 3 Greed, 4 NoRoll, 5 Pass) --
--    if a record's rollType ever looks wrong, check a real roll's state
--    against these before assuming a different bug.
--
-- Parsing loot chat text: Blizzard ships the exact format strings used to
-- build these messages (LOOT_ITEM, LOOT_ITEM_MULTIPLE, LOOT_ITEM_SELF,
-- LOOT_ITEM_SELF_MULTIPLE) specifically so addons don't have to hardcode
-- English text -- they work in every client locale. We convert each one
-- into a Lua pattern once at load time.
--
-- Quality floor: neither path records anything below Uncommon (Poor/Common
-- trash is never worth tracking, boss kill or Group Loot roll or not) --
-- see meetsQualityFloor below.
-- ============================================================
local _, RaidLead = ...

-- Blizzard's stable raid difficulty IDs (used by DBM/Details/etc. for years).
local DIFFICULTY_NAMES = { [14] = 'normal', [15] = 'heroic', [16] = 'mythic', [17] = 'lfr' }

-- Populate with this tier's tier-token item IDs before relying on tier-token
-- tracking -- these are a small, fixed set per raid (source: Wowhead at the
-- start of the tier) and need updating every new raid tier, same cadence as
-- minTrackedItemLevel in Core.lua.
RaidLead.TIER_TOKEN_ITEM_IDS = {
  -- [123456] = true,
}

local ITEM_CLASS_ARMOR  = Enum.ItemClass and Enum.ItemClass.Armor  or 4
local ITEM_CLASS_WEAPON = Enum.ItemClass and Enum.ItemClass.Weapon or 2
local QUALITY_EPIC      = Enum.ItemQuality and Enum.ItemQuality.Epic or 4
local QUALITY_UNCOMMON  = Enum.ItemQuality and Enum.ItemQuality.Uncommon or 2

-- Floor for capturing anything at all -- Poor (0)/Common (1) trash (vendor
-- greys, random world-drop greens' little cousins, cloth/leather stacks
-- that sometimes get rolled on in Group Loot) is never worth recording,
-- boss kill or not.
local function meetsQualityFloor(itemQuality)
  return itemQuality and itemQuality >= QUALITY_UNCOMMON
end

local UPGRADE_TRACKS = { 'Veteran', 'Champion', 'Hero', 'Mythic' }

-- Enum.ItemBind -- bindType is GetItemInfo's 14th return value, confirmed
-- against https://warcraft.wiki.gg/wiki/Enum.ItemBind. Values 7-9 are the
-- Warband-account terminology introduced in patch 11.0.0 (War Within);
-- anything not listed here (e.g. 0/None) is left unshown rather than guessed.
local BIND_TYPE_NAMES = {
  [1] = 'Soulbound',              -- OnAcquire (bind on pickup)
  [2] = 'BoE',                    -- OnEquip
  [3] = 'Binds on Use',           -- OnUse
  [4] = 'Quest Item',             -- Quest
  [7] = 'Account Bound',          -- ToWoWAccount (legacy BoA)
  [8] = 'Warbound',               -- ToBnetAccount
  [9] = 'Warbound Until Equipped', -- ToBnetAccountUntilEquipped
}

-- Item quality TRACK (Veteran/Champion/Hero/Mythic) and upgrade level (e.g.
-- "4/8") aren't exposed by GetItemInfo -- they only ever show up as tooltip
-- text. NEEDS LIVE-CLIENT VERIFICATION: this scans every tooltip line for
-- "<Track> N/M" rather than assuming one exact line layout, so it should
-- keep working even if the surrounding wording changes -- but the track
-- names/format here should be checked against a real tooltip before
-- trusting this to track correctly. Best-effort: returns nils (never
-- errors) if the tooltip API is unavailable or no line matches.
local function GetUpgradeTrackInfo(itemLink)
  if not C_TooltipInfo or not C_TooltipInfo.GetHyperlink then return nil, nil, nil end
  local ok, data = pcall(C_TooltipInfo.GetHyperlink, itemLink)
  if not ok or not data or not data.lines then return nil, nil, nil end

  for _, line in ipairs(data.lines) do
    local text = line.leftText
    if text then
      for _, track in ipairs(UPGRADE_TRACKS) do
        local level, maxLevel = text:match(track .. '%s*(%d+)/(%d+)')
        if level then return track, tonumber(level), tonumber(maxLevel) end
      end
    end
  end
  return nil, nil, nil
end

local function globalStringToPattern(fmt)
  local pattern = fmt:gsub('%%%%', '\1')
  pattern = pattern:gsub('([%^%$%(%)%.%[%]%*%+%-%?])', '%%%1')
  pattern = pattern:gsub('%%s', '(.-)')
  pattern = pattern:gsub('%%d', '(%%d+)')
  pattern = pattern:gsub('\1', '%%%%')
  return '^' .. pattern .. '$'
end

local PATTERNS = {
  self          = LOOT_ITEM_SELF and globalStringToPattern(LOOT_ITEM_SELF),
  selfMultiple  = LOOT_ITEM_SELF_MULTIPLE and globalStringToPattern(LOOT_ITEM_SELF_MULTIPLE),
  other         = LOOT_ITEM and globalStringToPattern(LOOT_ITEM),
  otherMultiple = LOOT_ITEM_MULTIPLE and globalStringToPattern(LOOT_ITEM_MULTIPLE),
}

-- Tracks the boss context loot should be attributed to. Encounters end
-- slightly before the last loot for that kill actually gets rolled/handed
-- out, so we keep attributing to the just-ended boss for a short grace
-- window rather than clearing instantly on ENCOUNTER_END.
local currentEncounter = nil
local ENCOUNTER_GRACE_SECONDS = 45

-- Enum.EncounterLootDropRollState -- see the file header note above on why
-- this needs live-client confirmation before being trusted.
local ROLL_STATE_NAMES = {
  [0] = 'need',        -- NeedMainSpec
  [1] = 'need-offspec', -- NeedOffSpec
  [2] = 'transmog',
  [3] = 'greed',
  [4] = 'no-roll',
  [5] = 'pass',
}

-- lootListID isn't globally unique on its own (it resets per encounter), so
-- dedupe on "encounterID-lootListID" -- LOOT_HISTORY_UPDATE_DROP fires
-- repeatedly as a roll progresses (new roller, then resolution), and
-- recordLoot must only run once a drop actually has a winner.
local recordedRollDrops = {}

local eventFrame = CreateFrame('Frame')
eventFrame:RegisterEvent('ENCOUNTER_START')
eventFrame:RegisterEvent('ENCOUNTER_END')
eventFrame:RegisterEvent('CHAT_MSG_LOOT')
eventFrame:RegisterEvent('LOOT_HISTORY_UPDATE_DROP')

eventFrame:SetScript('OnEvent', function(_, event, ...)
  if event == 'ENCOUNTER_START' then
    local encounterID, encounterName, difficultyID = ...
    currentEncounter = {
      id         = encounterID,
      name       = encounterName,
      difficulty = DIFFICULTY_NAMES[difficultyID] or tostring(difficultyID),
    }
  elseif event == 'ENCOUNTER_END' then
    local encounterID, _, _, _, success = ...
    if success == 1 and currentEncounter and currentEncounter.id == encounterID then
      local endedEncounter = currentEncounter
      C_Timer.After(ENCOUNTER_GRACE_SECONDS, function()
        if currentEncounter == endedEncounter then currentEncounter = nil end
      end)
    else
      currentEncounter = nil
    end
  elseif event == 'CHAT_MSG_LOOT' then
    RaidLead.HandleLootMessage(...)
  elseif event == 'LOOT_HISTORY_UPDATE_DROP' then
    RaidLead.HandleLootHistoryDrop(...)
  end
end)

local function matchLootMessage(msg)
  local playerName = UnitName('player')

  if PATTERNS.otherMultiple then
    local name, link, count = msg:match(PATTERNS.otherMultiple)
    if name and link then return name, link, tonumber(count) or 1 end
  end
  if PATTERNS.other then
    local name, link = msg:match(PATTERNS.other)
    if name and link then return name, link, 1 end
  end
  if PATTERNS.selfMultiple then
    local link, count = msg:match(PATTERNS.selfMultiple)
    if link then return playerName, link, tonumber(count) or 1 end
  end
  if PATTERNS.self then
    local link = msg:match(PATTERNS.self)
    if link then return playerName, link, 1 end
  end
  return nil
end

-- `encounterOverride` lets the Group Loot path (below) supply the
-- encounterID straight from LOOT_HISTORY_UPDATE_DROP, since a roll can take
-- long enough to resolve that currentEncounter's grace window has already
-- expired by then; personal loot keeps using currentEncounter as before by
-- passing nothing. `rollInfo`, when present, marks this record as won via
-- a Group Loot roll rather than Personal Loot.
local function recordLoot(recipientName, itemLink, itemId, itemName, isTierToken, isBoe, itemMeta, rollInfo, encounterOverride)
  itemMeta = itemMeta or {}
  local encounter = encounterOverride or currentEncounter
  local id = string.format('%s-%d-%d-%s', RaidLead.sessionId, time(), itemId, recipientName)
  RaidLeadDB.lootRecords[id] = {
    addonRecordId  = id,
    sessionId      = RaidLead.sessionId,
    likelyPug      = RaidLead.IsLikelyPug(),
    capturedAt     = time(),
    raidDate       = date('%Y-%m-%d'),
    encounterId    = encounter and encounter.id or nil,
    bossName       = encounter and encounter.name or nil,
    difficulty     = encounter and encounter.difficulty or nil,
    itemId         = itemId,
    itemName       = itemName,
    isTierToken    = isTierToken,
    isBoe          = isBoe,
    recipientName  = recipientName,
    qualityTrack   = itemMeta.qualityTrack,
    upgradeLevel   = itemMeta.upgradeLevel,
    upgradeLevelMax = itemMeta.upgradeLevelMax,
    itemSlot       = itemMeta.itemSlot,
    armorType      = itemMeta.armorType,
    bindType       = itemMeta.bindType,
    lootMethod     = rollInfo and 'roll' or 'personal',
    rollType       = rollInfo and rollInfo.rollType or nil,
    rollValue      = rollInfo and rollInfo.rollValue or nil,
    rollParticipants = rollInfo and rollInfo.participants or nil,
  }
  RaidLead.RefreshExport()
  if RaidLead.UI and RaidLead.UI.RefreshLoot then RaidLead.UI.RefreshLoot() end
end

-- Resolves an item link's cached info plus our extra metadata (upgrade
-- track/slot/armor type), waiting on the item data cache if needed. Shared
-- by both the Personal Loot and Group Loot capture paths below so there's
-- one implementation of this, not two that can drift apart.
-- callback(itemName, itemQuality, itemLevel, itemClassID, itemMeta) --
-- itemMeta is always a table (fields nil where not applicable/found).
local function resolveItemMetaAsync(itemLink, callback)
  local item = Item:CreateFromItemLink(itemLink)
  item:ContinueOnItemLoad(function()
    local itemName, _, itemQuality, itemLevel, _, _, itemSubType, _, itemEquipLoc, _, _, itemClassID, _, bindType =
      GetItemInfo(itemLink)
    if not itemQuality then return end

    -- itemEquipLoc is an internal token (e.g. "INVTYPE_HEAD") -- Blizzard
    -- ships a matching global string for each one that's already the
    -- human-readable, localized slot name ("Head"), same trick this addon
    -- already relies on for LOOT_ITEM/etc. above.
    local itemSlot = itemEquipLoc and itemEquipLoc ~= '' and (_G[itemEquipLoc] or nil) or nil
    local armorType = (itemClassID == ITEM_CLASS_ARMOR) and itemSubType or nil
    local qualityTrack, upgradeLevel, upgradeLevelMax = GetUpgradeTrackInfo(itemLink)
    local itemMeta = {
      itemSlot = itemSlot, armorType = armorType,
      qualityTrack = qualityTrack, upgradeLevel = upgradeLevel, upgradeLevelMax = upgradeLevelMax,
      bindType = BIND_TYPE_NAMES[bindType],
    }
    callback(itemName, itemQuality, itemLevel, itemClassID, itemMeta)
  end)
end

-- Exposed for the OnEvent handler above.
function RaidLead.HandleLootMessage(msg)
  local ok, err = pcall(function()
    local recipientName, itemLink, count = matchLootMessage(msg)
    if not recipientName or not itemLink then return end
    -- Cross-realm raid members show up in loot chat as "Name-Realm", but
    -- every name this addon/site ever compares against (the roster mirror,
    -- the characters table) is stored bare -- without this, loot awarded to
    -- anyone not on the looter's own realm silently failed to match a
    -- roster character server-side and looked like it never happened.
    recipientName = Ambiguate(recipientName, 'short')

    local itemId = tonumber(itemLink:match('item:(%d+)'))
    if not itemId then return end

    resolveItemMetaAsync(itemLink, function(itemName, itemQuality, itemLevel, itemClassID, itemMeta)
      if not meetsQualityFloor(itemQuality) then return end

      local isTierToken = RaidLead.TIER_TOKEN_ITEM_IDS[itemId] == true
      local isBossLoot  = currentEncounter ~= nil

      if isTierToken or isBossLoot then
        -- Real gear always carries an upgrade track (Veteran/Champion/Hero/
        -- Mythic) in current content -- quest currency, catalyst fragments,
        -- and similar junk (e.g. "Mask Fragment", "Spark of Tides") don't,
        -- even though they clear the quality floor above. Tier tokens are
        -- exempt: they're an explicit opt-in via TIER_TOKEN_ITEM_IDS and
        -- some don't carry a track themselves.
        if not isTierToken and not itemMeta.qualityTrack then return end
        recordLoot(recipientName, itemLink, itemId, itemName, isTierToken, false, itemMeta)
        return
      end

      -- Not attributed to a boss -- only capture it if it looks like a
      -- tier-relevant BoE (Epic armor/weapon at or above this tier's floor),
      -- so trash mobs' cloth/gold/greens never show up in loot history.
      if itemQuality ~= QUALITY_EPIC then return end
      if itemClassID ~= ITEM_CLASS_ARMOR and itemClassID ~= ITEM_CLASS_WEAPON then return end
      if not itemLevel or itemLevel < (RaidLeadDB.settings.minTrackedItemLevel or 0) then return end
      if not itemMeta.qualityTrack then return end

      recordLoot(recipientName, itemLink, itemId, itemName, false, true, itemMeta)
    end)
  end)
  if not ok then
    -- Never let a malformed/unexpected loot message take down the addon.
    -- (uncomment while debugging: print('|cffff4444RaidLead loot parse error|r: ' .. tostring(err)))
  end
end

-- Exposed for the OnEvent handler above. Group Loot: fires as a roll's
-- state changes (a new roller, then resolution) -- potentially several
-- times per drop, so this only acts once `winner` is actually populated,
-- and recordedRollDrops makes sure it only records once per drop even if
-- the event fires again afterward (e.g. someone opening the loot history
-- panel re-triggers a refresh).
function RaidLead.HandleLootHistoryDrop(encounterID, lootListID)
  local ok, err = pcall(function()
    if not encounterID or not lootListID then return end
    local dedupeKey = encounterID .. '-' .. lootListID
    if recordedRollDrops[dedupeKey] then return end

    local drops = C_LootHistory.GetSortedDropsForEncounter(encounterID)
    if not drops then return end

    local drop
    for _, d in ipairs(drops) do
      if d.lootListID == lootListID then drop = d; break end
    end
    if not drop or not drop.winner then return end -- roll not resolved yet

    recordedRollDrops[dedupeKey] = true

    local itemLink = drop.itemHyperlink
    if not itemLink then return end
    local itemId = tonumber(itemLink:match('item:(%d+)'))
    if not itemId then return end

    -- Same cross-realm normalization as the Personal Loot path above.
    local winnerName = Ambiguate(drop.winner.playerName, 'short')
    local rollType   = ROLL_STATE_NAMES[drop.winner.state]
    local rollValue  = drop.winner.roll

    local participants = {}
    for _, r in ipairs(drop.rollInfos or {}) do
      table.insert(participants, {
        name      = Ambiguate(r.playerName, 'short'),
        rollType  = ROLL_STATE_NAMES[r.state],
        rollValue = r.roll,
        isWinner  = r.isWinner and true or false,
      })
    end

    -- A slow roll can resolve after currentEncounter's grace window has
    -- already expired -- use the event's own encounterID either way, and
    -- fall back to the Encounter Journal for the boss name only if
    -- currentEncounter doesn't already have it. Best-effort: boss_name is
    -- a nullable column, and EJ_GetEncounterInfo can return nil if the
    -- Encounter Journal addon hasn't been loaded this session.
    local encounterName, difficulty
    if currentEncounter and currentEncounter.id == encounterID then
      encounterName = currentEncounter.name
      difficulty = currentEncounter.difficulty
    elseif EJ_GetEncounterInfo then
      encounterName = EJ_GetEncounterInfo(encounterID)
    end

    resolveItemMetaAsync(itemLink, function(itemName, itemQuality, _, _, itemMeta)
      if not meetsQualityFloor(itemQuality) then return end

      local isTierToken = RaidLead.TIER_TOKEN_ITEM_IDS[itemId] == true
      -- Same "real gear has a track" reasoning as the Personal Loot path --
      -- see there for why. Tier tokens are exempt.
      if not isTierToken and not itemMeta.qualityTrack then return end

      recordLoot(winnerName, itemLink, itemId, itemName, isTierToken, false, itemMeta,
        { rollType = rollType, rollValue = rollValue, participants = participants },
        { id = encounterID, name = encounterName, difficulty = difficulty })
    end)
  end)
  if not ok then
    -- Never let a malformed/unexpected loot-history update take down the addon.
    -- (uncomment while debugging: print('|cffff4444RaidLead loot-roll parse error|r: ' .. tostring(err)))
  end
end
