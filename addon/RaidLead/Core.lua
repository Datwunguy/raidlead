-- ============================================================
-- Core.lua — addon init, saved-variable bootstrap, session id,
-- pug-likelihood check, slash commands.
--
-- This addon is deliberately a read + append-only helper (see the
-- RaidLead implementation plan): it can only view the plan/roster the
-- companion app mirrors down, and can only append new loot records --
-- never edit a plan, never edit a previously-recorded loot row. Any
-- correction (a trade, deleting a non-guild run) happens on the website,
-- gated to Officers/Owners there.
-- ============================================================
local ADDON_NAME, RaidLead = ...

RaidLead.PUG_MATCH_THRESHOLD = 0.6 -- below this fraction of matched names, a session is flagged likely_pug

local DEFAULT_DB = {
  settings = {
    minTrackedItemLevel = 636, -- bump this at the start of each new raid tier (Champion track floor)
  },
  lootRecords = {}, -- addon_record_id -> record, pruned on load; uploaded wholesale each sync
  minimap = { angle = 225, hidden = false }, -- minimap button position/visibility, see UI/MinimapButton.lua
}

local DEFAULT_COMPANION_DB = {
  plan = nil,     -- { name, raidDate, updatedAt, members = { {name, class, primaryRole, assignedRole}, ... } }
  roster = nil,   -- { {name, class, primaryRole}, ... } -- full team character list, for pug detection
  syncedAt = nil,
}

local PRUNE_AFTER_DAYS = 45

local function mergeDefaults(saved, defaults)
  saved = saved or {}
  for k, v in pairs(defaults) do
    if saved[k] == nil then saved[k] = v end
  end
  return saved
end

local eventFrame = CreateFrame('Frame')
eventFrame:RegisterEvent('ADDON_LOADED')
eventFrame:RegisterEvent('PLAYER_LOGIN')

local function pruneOldLootRecords()
  local cutoff = time() - (PRUNE_AFTER_DAYS * 24 * 60 * 60)
  for id, record in pairs(RaidLeadDB.lootRecords) do
    if (record.capturedAt or 0) < cutoff then
      RaidLeadDB.lootRecords[id] = nil
    end
  end
end

-- RaidLeadDB.lootRecords is a rich native Lua table for the addon's own use
-- (pruning, etc.). The companion app is a Node process, not a Lua VM, so it
-- can't read that Lua-table-literal syntax directly -- RaidLeadExportDB is
-- kept as a single JSON string mirroring the same data, specifically so the
-- companion app only ever needs a JSON parser, never a Lua one, for the
-- loot-upload direction. Recomputed on load and after every new record.
function RaidLead.RefreshExport()
  RaidLeadExportDB = RaidLead.Json.encode(RaidLeadDB.lootRecords)
end

-- Multiple modules (Roster.lua, UI/MinimapButton.lua) need a "player has
-- logged in, my saved data is ready" hook -- a list here rather than a
-- single named function, so the second module to register doesn't
-- silently clobber the first's callback.
local playerLoginHandlers = {}
function RaidLead.RegisterOnPlayerLogin(fn)
  table.insert(playerLoginHandlers, fn)
end

local function startNewSession()
  RaidLead.sessionId = date('%Y%m%d%H%M%S') .. '-' .. math.random(100000, 999999)
  RaidLead.sessionLikelyPugComputed = false
  RaidLead.sessionLikelyPug = false
end

-- Best-effort: what fraction of the current raid/party's names match a known
-- character on this team's roster (mirrored down by the companion app)?
-- Computed once per session and cached -- a guild run doesn't stop being one
-- because someone drops group mid-raid.
function RaidLead.IsLikelyPug()
  if RaidLead.sessionLikelyPugComputed then return RaidLead.sessionLikelyPug end

  local knownRoster = RaidLeadCompanionDB and RaidLeadCompanionDB.roster
  if not knownRoster or #knownRoster == 0 then
    -- No roster synced yet -- can't classify, so don't guess "pug" and risk
    -- hiding a real guild run behind the flag. Treat as unknown/not-pug.
    RaidLead.sessionLikelyPugComputed = true
    RaidLead.sessionLikelyPug = false
    return false
  end

  local knownNames = {}
  for _, char in ipairs(knownRoster) do
    if char.name then knownNames[Ambiguate(char.name, 'short'):lower()] = true end
  end

  local numGroup = GetNumGroupMembers()
  if numGroup == 0 then return false end

  local matched, total = 0, 0
  if IsInRaid() then
    for i = 1, numGroup do
      local name = (GetRaidRosterInfo(i))
      if name then
        total = total + 1
        if knownNames[Ambiguate(name, 'short'):lower()] then matched = matched + 1 end
      end
    end
  else
    for i = 1, numGroup do
      local unit = i == numGroup and 'player' or ('party' .. i)
      local name = UnitName(unit)
      if name then
        total = total + 1
        if knownNames[Ambiguate(name, 'short'):lower()] then matched = matched + 1 end
      end
    end
  end

  RaidLead.sessionLikelyPugComputed = true
  RaidLead.sessionLikelyPug = total > 0 and (matched / total) < RaidLead.PUG_MATCH_THRESHOLD
  return RaidLead.sessionLikelyPug
end

eventFrame:SetScript('OnEvent', function(_, event, addonName)
  if event == 'ADDON_LOADED' and addonName == ADDON_NAME then
    RaidLeadDB = mergeDefaults(RaidLeadDB, DEFAULT_DB)
    RaidLeadDB.settings = mergeDefaults(RaidLeadDB.settings, DEFAULT_DB.settings)
    RaidLeadDB.minimap  = mergeDefaults(RaidLeadDB.minimap, DEFAULT_DB.minimap)
    RaidLeadCompanionDB = mergeDefaults(RaidLeadCompanionDB, DEFAULT_COMPANION_DB)
    pruneOldLootRecords()
    RaidLead.RefreshExport()
  elseif event == 'PLAYER_LOGIN' then
    startNewSession()
    for _, fn in ipairs(playerLoginHandlers) do fn() end
  end
end)

-- ── Slash commands ──────────────────────────────────────────
SLASH_RAIDLEAD1 = '/raidlead'
SlashCmdList['RAIDLEAD'] = function(msg)
  local cmd, rest = msg:match('^(%S*)%s*(.-)$')
  cmd = (cmd or ''):lower()

  if cmd == 'ilvl' and tonumber(rest) then
    RaidLeadDB.settings.minTrackedItemLevel = tonumber(rest)
    print('|cff33ff99RaidLead|r: tracking BoEs at item level ' .. rest .. '+')
  elseif cmd == 'status' then
    local synced = RaidLeadCompanionDB and RaidLeadCompanionDB.syncedAt
    print('|cff33ff99RaidLead|r: session ' .. (RaidLead.sessionId or '?')
      .. ', roster last synced ' .. (synced and date('%Y-%m-%d %H:%M', synced) or 'never'))
  elseif cmd == 'minimap' then
    local newShown = RaidLeadDB.minimap.hidden -- toggle: currently hidden -> show, currently shown -> hide
    if RaidLead.UI.SetMinimapButtonShown then RaidLead.UI.SetMinimapButtonShown(newShown) end
    print('|cff33ff99RaidLead|r: minimap icon ' .. (newShown and 'shown' or 'hidden'))
  else
    if RaidLead.ToggleRosterFrame then RaidLead.ToggleRosterFrame() end
  end
end
