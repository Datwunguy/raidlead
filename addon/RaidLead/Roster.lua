-- ============================================================
-- Roster.lua — mirrors the published Raid Planner roster and keeps a live
-- in-group/missing checklist. Purely a viewer: nothing here can edit the
-- plan, only read what the companion app already mirrored down into
-- RaidLeadCompanionDB. See UI/RosterFrame.lua for the actual frame.
-- ============================================================
local _, RaidLead = ...

local COLUMN_ORDER = { 'tanks', 'healers', 'melee', 'ranged' }
local COLUMN_LABELS = { tanks = 'Tanks', healers = 'Healers', melee = 'Melee', ranged = 'Ranged' }

local function baseColumnFor(primaryRole)
  local r = (primaryRole or ''):lower()
  if r == 'tank' then return 'tanks' end
  if r == 'heal' or r == 'healer' then return 'healers' end
  if r == 'melee' then return 'melee' end
  if r == 'ranged' then return 'ranged' end
  return 'ranged' -- unknown roles fall back to ranged rather than disappearing
end

local function columnFor(member)
  local assigned = (member.assignedRole or 'primary'):lower()
  if assigned == 'flex_tank'   then return 'tanks' end
  if assigned == 'flex_heal'   then return 'healers' end
  if assigned == 'flex_melee'  then return 'melee' end
  if assigned == 'flex_ranged' then return 'ranged' end
  return baseColumnFor(member.primaryRole)
end

-- RaidLead stores realms as lowercase, hyphenated slugs (e.g.
-- "bleeding-hollow", same format Raider.io's API wants) -- WoW's own
-- Name-Realm invite format needs them title-cased with no separator at all
-- (e.g. "BleedingHollow"). NEEDS LIVE-CLIENT VERIFICATION for any realm
-- whose real name has an apostrophe or other punctuation the slug already
-- dropped server-side (e.g. "Kel'Thuzad" -> stored as "kelthuzad" ->
-- reconstructed here as "Kelthuzad", missing the apostrophe) -- not an
-- issue for any realm currently on this guild's roster, but worth knowing
-- if inviting to one specific realm ever silently fails.
local function realmNameFromSlug(slug)
  if not slug or slug == '' then return nil end
  local parts = {}
  for word in slug:gmatch('[^-]+') do
    table.insert(parts, word:sub(1, 1):upper() .. word:sub(2))
  end
  if #parts == 0 then return nil end
  return table.concat(parts)
end

-- Builds whatever C_PartyInfo.InviteUnit actually needs to find this
-- person -- a bare name only resolves same-realm (and connected realms);
-- anyone else needs "Name-Realm" or the client reports "player not found"
-- even though they're a real roster member. Falls back to the bare name if
-- no server was synced down (shouldn't normally happen, but never worse
-- than the old always-bare-name behavior).
local function inviteTargetFor(entry)
  if not entry or not entry.name then return nil end
  local realm = realmNameFromSlug(entry.server)
  if realm then return entry.name .. '-' .. realm end
  return entry.name
end

-- Online/offline, via the player's actual in-game guild roster -- this
-- works even for someone currently missing from group, unlike any
-- group/raid-only API, as long as they're in the same real WoW guild (true
-- for virtually every use of this addon, since it's built around a single
-- guild's raid roster). Not the same thing as "in RaidLead's roster" to the
-- game client, but they're the same set of people in every normal case.
local onlineStatus = {} -- Ambiguate("short"):lower() -> true/false

local function refreshOnlineStatus()
  if not IsInGuild() then wipe(onlineStatus); return end
  local numMembers = GetNumGuildMembers and GetNumGuildMembers() or 0
  for i = 1, numMembers do
    local name, _, _, _, _, _, _, _, isOnline = GetGuildRosterInfo(i)
    if name then
      onlineStatus[Ambiguate(name, 'short'):lower()] = isOnline == true
    end
  end
end

-- Names currently in the player's group, as a lookup set of Ambiguate("short") names.
local function currentGroupNameSet()
  local set = {}
  local numGroup = GetNumGroupMembers()
  if numGroup == 0 then
    set[Ambiguate(UnitName('player'), 'short'):lower()] = true
    return set
  end
  if IsInRaid() then
    for i = 1, numGroup do
      local name = (GetRaidRosterInfo(i))
      if name then set[Ambiguate(name, 'short'):lower()] = true end
    end
  else
    for i = 1, numGroup do
      local unit = i == numGroup and 'player' or ('party' .. i)
      local name = UnitName(unit)
      if name then set[Ambiguate(name, 'short'):lower()] = true end
    end
  end
  return set
end

-- Builds { tanks = {...}, healers = {...}, melee = {...}, ranged = {...},
-- unavailable = {...}, counts = {...} } from the mirrored plan, with each
-- roster entry's live inGroup status filled in.
function RaidLead.BuildRosterColumns()
  local plan = RaidLeadCompanionDB and RaidLeadCompanionDB.plan
  if not plan then return nil end

  local groupNames = currentGroupNameSet()
  local columns = { tanks = {}, healers = {}, melee = {}, ranged = {} }
  local allNames = {}

  for _, member in ipairs(plan.members or {}) do
    local col = columnFor(member)
    local shortName = member.name and Ambiguate(member.name, 'short'):lower() or ''
    table.insert(columns[col], {
      name     = member.name,
      class    = member.class,
      server   = member.server,
      inGroup  = groupNames[shortName] == true,
      isOnline = onlineStatus[shortName],
    })
    if member.name then table.insert(allNames, { name = member.name, server = member.server }) end
  end

  for _, col in pairs(columns) do
    table.sort(col, function(a, b) return (a.name or '') < (b.name or '') end)
  end

  local unavailable = {}
  for _, name in ipairs(plan.unavailable or {}) do
    local shortName = Ambiguate(name, 'short'):lower()
    table.insert(unavailable, { name = name, isOnline = onlineStatus[shortName] })
  end

  return {
    planName    = plan.name,
    raidDate    = plan.raidDate,
    columns     = columns,
    columnOrder = COLUMN_ORDER,
    columnLabels = COLUMN_LABELS,
    allNames    = allNames,
    unavailable = unavailable,
  }
end

function RaidLead.CanInvite()
  -- Not in any group yet counts as "can invite" too -- UnitIsGroupLeader/
  -- Assistant are both false when there's no group at all (there's nothing
  -- to lead), but any player can freely send an invite in that state, which
  -- automatically makes them the new group's leader. Without this, the
  -- button never shows for the very first invite of the night, before
  -- anyone's grouped up yet -- the single most common time to use it.
  if GetNumGroupMembers() == 0 then return true end
  return UnitIsGroupLeader('player') or UnitIsGroupAssistant('player')
end

-- `entries` is a list of { name, server } tables (server may be nil).
function RaidLead.InviteMissing(entries)
  if not RaidLead.CanInvite() then return end
  for _, entry in ipairs(entries) do
    local target = inviteTargetFor(entry)
    if target then
      if C_PartyInfo and C_PartyInfo.InviteUnit then
        C_PartyInfo.InviteUnit(target)
      elseif InviteUnit then
        InviteUnit(target)
      end
    end
  end
end

-- Kicks everyone currently in the group (except the player) and re-invites
-- the full published roster -- for reforming a group from scratch rather
-- than topping up who's missing. Uninviting still needs actual in-game
-- permission (leader, or assistant in a raid); CanInvite() is reused as the
-- gate for showing the button, same as Invite Missing, but the server is
-- always the real authority -- an UninviteUnit call this player genuinely
-- can't make just does nothing. `allEntries` is the same { name, server }
-- shape InviteMissing takes -- passed straight through to it below.
function RaidLead.DisbandAndReinvite(allEntries)
  if not RaidLead.CanInvite() then return end

  local myShortName = Ambiguate(UnitName('player'), 'short')
  local numGroup = GetNumGroupMembers()

  if IsInRaid() then
    for i = numGroup, 1, -1 do
      local name = (GetRaidRosterInfo(i))
      if name and Ambiguate(name, 'short') ~= myShortName then
        if C_PartyInfo and C_PartyInfo.UninviteUnit then
          C_PartyInfo.UninviteUnit(name)
        elseif UninviteUnit then
          UninviteUnit(name)
        end
      end
    end
  elseif numGroup > 0 then
    for i = 1, numGroup do
      local name = UnitName('party' .. i)
      if name then
        if C_PartyInfo and C_PartyInfo.UninviteUnit then
          C_PartyInfo.UninviteUnit(name)
        elseif UninviteUnit then
          UninviteUnit(name)
        end
      end
    end
  end

  -- A short delay so the kicks actually process server-side before the
  -- re-invites go out, rather than racing a mid-disband group state.
  C_Timer.After(1.5, function() RaidLead.InviteMissing(allEntries or {}) end)
end

local function refresh()
  if RaidLead.UI and RaidLead.UI.Update then
    RaidLead.UI.Update(RaidLead.BuildRosterColumns())
  end
end

local eventFrame = CreateFrame('Frame')
eventFrame:RegisterEvent('GROUP_ROSTER_UPDATE')
eventFrame:RegisterEvent('GUILD_ROSTER_UPDATE')
eventFrame:SetScript('OnEvent', function(_, event)
  if event == 'GUILD_ROSTER_UPDATE' then refreshOnlineStatus() end
  refresh()
end)

function RaidLead.ToggleRosterFrame()
  if RaidLead.UI and RaidLead.UI.Toggle then
    -- GuildRoster() just requests an update -- GUILD_ROSTER_UPDATE fires
    -- (often near-instantly from cache) once it's actually ready, which is
    -- what refreshes onlineStatus and re-renders above.
    if IsInGuild() and C_GuildInfo and C_GuildInfo.GuildRoster then C_GuildInfo.GuildRoster() end
    refresh()
    RaidLead.UI.Toggle()
  end
end

RaidLead.RegisterOnPlayerLogin(function()
  if IsInGuild() and C_GuildInfo and C_GuildInfo.GuildRoster then C_GuildInfo.GuildRoster() end
  refresh()
end)
