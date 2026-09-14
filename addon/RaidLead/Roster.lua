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
      name    = member.name,
      class   = member.class,
      inGroup = groupNames[shortName] == true,
    })
    if member.name then table.insert(allNames, member.name) end
  end

  for _, col in pairs(columns) do
    table.sort(col, function(a, b) return (a.name or '') < (b.name or '') end)
  end

  local unavailable = {}
  for _, name in ipairs(plan.unavailable or {}) do
    table.insert(unavailable, { name = name })
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

function RaidLead.InviteMissing(names)
  if not RaidLead.CanInvite() then return end
  for _, name in ipairs(names) do
    if C_PartyInfo and C_PartyInfo.InviteUnit then
      C_PartyInfo.InviteUnit(name)
    elseif InviteUnit then
      InviteUnit(name)
    end
  end
end

-- Kicks everyone currently in the group (except the player) and re-invites
-- the full published roster -- for reforming a group from scratch rather
-- than topping up who's missing. Uninviting still needs actual in-game
-- permission (leader, or assistant in a raid); CanInvite() is reused as the
-- gate for showing the button, same as Invite Missing, but the server is
-- always the real authority -- an UninviteUnit call this player genuinely
-- can't make just does nothing.
function RaidLead.DisbandAndReinvite(allNames)
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
  C_Timer.After(1.5, function() RaidLead.InviteMissing(allNames or {}) end)
end

local function refresh()
  if RaidLead.UI and RaidLead.UI.Update then
    RaidLead.UI.Update(RaidLead.BuildRosterColumns())
  end
end

local eventFrame = CreateFrame('Frame')
eventFrame:RegisterEvent('GROUP_ROSTER_UPDATE')
eventFrame:SetScript('OnEvent', refresh)

function RaidLead.ToggleRosterFrame()
  if RaidLead.UI and RaidLead.UI.Toggle then
    refresh()
    RaidLead.UI.Toggle()
  end
end

RaidLead.RegisterOnPlayerLogin(refresh)
