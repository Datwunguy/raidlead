-- ============================================================
-- Loot.lua — encounter tracking + loot capture + BoE filtering.
--
-- NEEDS LIVE-CLIENT VERIFICATION (flagged in the implementation plan):
-- this captures raid-wide Personal Loot via CHAT_MSG_LOOT, which is a
-- long-standing, well-documented chat event that fires for every raid
-- member's loot, not just your own -- that part is solid. What's NOT
-- yet verified against a live client is whether a more direct API (the
-- in-game Group Loot History panel) would be a cleaner primary source;
-- if so, this file is where to add it. CHAT_MSG_LOOT should be treated
-- as the reliable baseline either way.
--
-- Parsing loot chat text: Blizzard ships the exact format strings used to
-- build these messages (LOOT_ITEM, LOOT_ITEM_MULTIPLE, LOOT_ITEM_SELF,
-- LOOT_ITEM_SELF_MULTIPLE) specifically so addons don't have to hardcode
-- English text -- they work in every client locale. We convert each one
-- into a Lua pattern once at load time.
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

local UPGRADE_TRACKS = { 'Veteran', 'Champion', 'Hero', 'Mythic' }

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

local eventFrame = CreateFrame('Frame')
eventFrame:RegisterEvent('ENCOUNTER_START')
eventFrame:RegisterEvent('ENCOUNTER_END')
eventFrame:RegisterEvent('CHAT_MSG_LOOT')

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

local function recordLoot(recipientName, itemLink, itemId, itemName, isTierToken, isBoe, itemMeta)
  itemMeta = itemMeta or {}
  local id = string.format('%s-%d-%d-%s', RaidLead.sessionId, time(), itemId, recipientName)
  RaidLeadDB.lootRecords[id] = {
    addonRecordId  = id,
    sessionId      = RaidLead.sessionId,
    likelyPug      = RaidLead.IsLikelyPug(),
    capturedAt     = time(),
    raidDate       = date('%Y-%m-%d'),
    encounterId    = currentEncounter and currentEncounter.id or nil,
    bossName       = currentEncounter and currentEncounter.name or nil,
    difficulty     = currentEncounter and currentEncounter.difficulty or nil,
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
  }
  RaidLead.RefreshExport()
  if RaidLead.UI and RaidLead.UI.RefreshLoot then RaidLead.UI.RefreshLoot() end
end

-- Exposed for the OnEvent handler above.
function RaidLead.HandleLootMessage(msg)
  local ok, err = pcall(function()
    local recipientName, itemLink, count = matchLootMessage(msg)
    if not recipientName or not itemLink then return end

    local itemId = tonumber(itemLink:match('item:(%d+)'))
    if not itemId then return end

    local item = Item:CreateFromItemLink(itemLink)
    item:ContinueOnItemLoad(function()
      local itemName, _, itemQuality, itemLevel, _, _, itemSubType, _, itemEquipLoc, _, _, itemClassID = GetItemInfo(itemLink)
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
      }

      local isTierToken = RaidLead.TIER_TOKEN_ITEM_IDS[itemId] == true
      local isBossLoot  = currentEncounter ~= nil

      if isTierToken or isBossLoot then
        recordLoot(recipientName, itemLink, itemId, itemName, isTierToken, false, itemMeta)
        return
      end

      -- Not attributed to a boss -- only capture it if it looks like a
      -- tier-relevant BoE (Epic armor/weapon at or above this tier's floor),
      -- so trash mobs' cloth/gold/greens never show up in loot history.
      if itemQuality ~= QUALITY_EPIC then return end
      if itemClassID ~= ITEM_CLASS_ARMOR and itemClassID ~= ITEM_CLASS_WEAPON then return end
      if not itemLevel or itemLevel < (RaidLeadDB.settings.minTrackedItemLevel or 0) then return end

      recordLoot(recipientName, itemLink, itemId, itemName, false, true, itemMeta)
    end)
  end)
  if not ok then
    -- Never let a malformed/unexpected loot message take down the addon.
    -- (uncomment while debugging: print('|cffff4444RaidLead loot parse error|r: ' .. tostring(err)))
  end
end
