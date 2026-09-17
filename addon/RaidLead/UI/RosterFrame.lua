-- ============================================================
-- UI/RosterFrame.lua — the shared RaidLead window chrome (title, close,
-- Roster/Loot tabs) plus the Roster pane itself. Visually modeled on the
-- website's "Tonight's Roster" card: two stacked columns (Tanks over
-- Melee, Healers over Ranged), a full-width Out/Unavailable strip, dark
-- background, class-colored name pills. Exact pixel styling will get
-- tuned once someone's actually looked at this in-game -- this is a
-- first, functional pass at that layout, not a pixel-perfect port.
--
-- The Loot pane (UI/LootFrame.lua, loaded after this file) hooks into the
-- same window via RaidLead.UI.BuildLootContent, called from ensureFrame()
-- below once the shared tab chrome exists.
-- ============================================================
local _, RaidLead = ...
RaidLead.UI = RaidLead.UI or {}
local UI = RaidLead.UI

StaticPopupDialogs['RAIDLEAD_CONFIRM_DISBAND'] = {
  text = 'Kick everyone currently in your group and re-invite the full published roster?\n\nThis can\'t be undone -- anyone kicked will need to be re-invited manually if something goes wrong.',
  button1 = 'Disband & Reinvite',
  button2 = 'Cancel',
  OnAccept = function()
    if RaidLead.UI.EnsureFrame then
      RaidLead.DisbandAndReinvite(RaidLead.UI.EnsureFrame().allNames or {})
    end
  end,
  timeout = 0,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

local BG = { 0.06, 0.06, 0.07, 0.95 }
local PILL_HEIGHT = 22
local PILL_GAP = 4
local SECTION_GAP = 20
local COLUMN_WIDTH = 210
local CONTENT_TOP = 74 -- leaves room for the title row + tab row above the content area; also what the Loot pane's own single top button uses
-- The Roster pane additionally has its own button row (Invite Missing /
-- Disband & Reinvite, moved here from the bottom -- see below for why) that
-- the Loot pane doesn't need, so its columns start a bit further down than
-- CONTENT_TOP alone would give.
local ROSTER_CONTENT_TOP = CONTENT_TOP + 34
local FRAME_MIN_HEIGHT = 300
local FRAME_BOTTOM_PADDING = 20

local frame

local function makeSectionHeader(parent)
  local fs = parent:CreateFontString(nil, 'OVERLAY', 'GameFontNormalSmall')
  fs:SetTextColor(1, 0.82, 0.1)
  return fs
end

local function makePill(parent)
  local btn = CreateFrame('Button', nil, parent, 'BackdropTemplate')
  btn:SetSize(COLUMN_WIDTH, PILL_HEIGHT)
  btn:SetBackdrop({ bgFile = 'Interface\\Buttons\\WHITE8x8' })

  local dot = btn:CreateTexture(nil, 'ARTWORK')
  dot:SetSize(6, 6)
  dot:SetPoint('LEFT', 8, 0)
  dot:SetColorTexture(1, 1, 1, 0.6)
  btn.dot = dot

  local text = btn:CreateFontString(nil, 'OVERLAY', 'GameFontNormalSmall')
  text:SetPoint('LEFT', dot, 'RIGHT', 6, 0)
  text:SetTextColor(1, 1, 1)
  btn.text = text

  -- Separate from `dot` above (which signals in-group via opacity) --
  -- online/offline, from the real in-game guild roster, so someone missing
  -- from the raid can be told apart from someone missing AND offline.
  local statusDot = btn:CreateTexture(nil, 'OVERLAY')
  statusDot:SetSize(7, 7)
  statusDot:SetPoint('RIGHT', -8, 0)
  statusDot:Hide() -- shown only once a real online/offline value is known
  btn.statusDot = statusDot

  btn:SetScript('OnClick', function(self)
    if self.missingEntry and RaidLead.CanInvite() then
      RaidLead.InviteMissing({ self.missingEntry })
    end
  end)

  return btn
end

-- Green if online, red if offline, hidden entirely if unknown (e.g. this
-- person isn't actually in the same in-game guild, or the guild roster
-- hasn't loaded yet) -- an absent dot is a clearer "no data" signal than
-- guessing a color.
local function applyStatusDot(pill, isOnline)
  if isOnline == nil then
    pill.statusDot:Hide()
    return
  end
  if isOnline then
    pill.statusDot:SetColorTexture(0.25, 0.85, 0.3, 1)
  else
    pill.statusDot:SetColorTexture(0.85, 0.25, 0.25, 1)
  end
  pill.statusDot:Show()
end

-- A small pool so we're not creating/destroying frames every refresh.
local pillPool = {}
local pillsInUse = {}

local function acquirePill(parent)
  local pill = table.remove(pillPool)
  if not pill then pill = makePill(parent) end
  pill:SetParent(parent)
  pill:SetSize(COLUMN_WIDTH, PILL_HEIGHT)
  pill:Show()
  table.insert(pillsInUse, pill)
  return pill
end

local function releaseAllPills()
  for _, pill in ipairs(pillsInUse) do
    pill:Hide()
    pill:ClearAllPoints()
    pill.missingEntry = nil
    pill.statusDot:Hide()
    table.insert(pillPool, pill)
  end
  wipe(pillsInUse)
end

-- Lays out one section (header already positioned/labelled by the caller)
-- directly beneath `header`, and returns the last frame placed (the header
-- itself if there were no entries) so the caller can chain the next section.
local function layoutSection(parent, header, entries)
  local prevAnchor, prevRelPoint = header, 'BOTTOMLEFT'
  for _, entry in ipairs(entries) do
    local pill = acquirePill(parent)
    pill:ClearAllPoints()
    pill:SetPoint('TOPLEFT', prevAnchor, prevRelPoint, 0, -PILL_GAP)

    local color = entry.inGroup and RaidLead.GetMutedClassColor(entry.class) or RaidLead.GetClassColor(entry.class)
    pill:SetBackdropColor(color.r, color.g, color.b, entry.inGroup and 0.35 or 0.85)
    pill.text:SetText(entry.name or '?')
    pill.dot:SetVertexColor(1, 1, 1, entry.inGroup and 0.35 or 1)
    pill.missingEntry = (not entry.inGroup) and { name = entry.name, server = entry.server, realmName = entry.realmName } or nil
    applyStatusDot(pill, entry.isOnline)

    prevAnchor, prevRelPoint = pill, 'BOTTOMLEFT'
  end
  return prevAnchor
end

local function makeTabButton(parent, label)
  local btn = CreateFrame('Button', nil, parent, 'UIPanelButtonTemplate')
  btn:SetSize(90, 22)
  btn:SetText(label)
  return btn
end

local function setActiveTab(activeBtn, inactiveBtn, showContent, hideContent)
  activeBtn:Disable() -- a flatly disabled look is the simplest "this one's active" cue available from the stock template
  inactiveBtn:Enable()
  showContent:Show()
  hideContent:Hide()
end

local function ensureFrame()
  if frame then return frame end

  frame = CreateFrame('Frame', 'RaidLeadRosterFrame', UIParent, 'BackdropTemplate')
  frame:SetSize(470, 560)
  frame:SetPoint('CENTER')
  frame:SetBackdrop({
    bgFile = 'Interface\\Buttons\\WHITE8x8',
    edgeFile = 'Interface\\Buttons\\WHITE8x8', edgeSize = 1,
  })
  frame:SetBackdropColor(unpack(BG))
  frame:SetBackdropBorderColor(0.25, 0.25, 0.28, 1)
  -- HIGH strata so this reliably renders above nameplates/unit frames/action
  -- bars (the default MEDIUM strata was getting buried behind other UI, per
  -- an in-game screenshot) -- one step below Blizzard's own DIALOG popups.
  frame:SetFrameStrata('HIGH')
  frame:SetToplevel(true)
  frame:SetMovable(true)
  frame:EnableMouse(true)
  frame:RegisterForDrag('LeftButton')
  frame:SetScript('OnDragStart', frame.StartMoving)
  frame:SetScript('OnDragStop', frame.StopMovingOrSizing)
  frame:SetClampedToScreen(true)
  frame:Hide()

  local title = frame:CreateFontString(nil, 'OVERLAY', 'GameFontNormalLarge')
  title:SetPoint('TOPLEFT', 16, -14)
  title:SetTextColor(0.8, 0.8, 0.85)
  frame.title = title

  local close = CreateFrame('Button', nil, frame, 'UIPanelCloseButton')
  close:SetPoint('TOPRIGHT', -4, -4)
  close:SetScript('OnClick', function() frame:Hide() end)

  -- ── Tabs ──
  local tabRoster = makeTabButton(frame, 'Roster')
  tabRoster:SetPoint('TOPLEFT', 16, -40)
  local tabLoot = makeTabButton(frame, 'Loot')
  tabLoot:SetPoint('LEFT', tabRoster, 'RIGHT', 6, 0)
  frame.tabRoster, frame.tabLoot = tabRoster, tabLoot

  -- ── Roster pane content, parented so the whole group shows/hides together ──
  local rosterContent = CreateFrame('Frame', nil, frame)
  rosterContent:SetPoint('TOPLEFT', 0, 0)
  rosterContent:SetPoint('BOTTOMRIGHT', 0, 0)
  frame.rosterContent = rosterContent

  local lootContent = CreateFrame('Frame', nil, frame)
  lootContent:SetPoint('TOPLEFT', 0, 0)
  lootContent:SetPoint('BOTTOMRIGHT', 0, 0)
  lootContent:Hide()
  frame.lootContent = lootContent

  tabRoster:SetScript('OnClick', function() setActiveTab(tabRoster, tabLoot, rosterContent, lootContent) end)
  tabLoot:SetScript('OnClick', function()
    setActiveTab(tabLoot, tabRoster, lootContent, rosterContent)
    if RaidLead.UI.RefreshLoot then RaidLead.UI.RefreshLoot() end
  end)
  tabRoster:Disable() -- roster tab is the default view

  -- Moved to the top of the pane (mirroring the Loot pane's own top button)
  -- -- these used to sit at the bottom of the frame, directly on top of the
  -- Out/Unavailable strip once that section had more than a couple of names.
  local inviteBtn = CreateFrame('Button', nil, rosterContent, 'UIPanelButtonTemplate')
  inviteBtn:SetSize(150, 22)
  inviteBtn:SetPoint('TOPRIGHT', frame, 'TOPRIGHT', -16, -CONTENT_TOP + 3)
  inviteBtn:SetText('Invite Missing')
  inviteBtn:SetScript('OnClick', function()
    RaidLead.InviteMissing(frame.missingEntries or {})
  end)
  frame.inviteBtn = inviteBtn

  local disbandBtn = CreateFrame('Button', nil, rosterContent, 'UIPanelButtonTemplate')
  disbandBtn:SetSize(150, 22)
  disbandBtn:SetPoint('RIGHT', inviteBtn, 'LEFT', -6, 0)
  disbandBtn:SetText('Disband & Reinvite')
  disbandBtn:SetScript('OnClick', function() StaticPopup_Show('RAIDLEAD_CONFIRM_DISBAND') end)
  frame.disbandBtn = disbandBtn

  local leftAnchor = CreateFrame('Frame', nil, rosterContent)
  leftAnchor:SetPoint('TOPLEFT', 16, -ROSTER_CONTENT_TOP)
  leftAnchor:SetSize(1, 1)
  frame.leftAnchor = leftAnchor

  local rightAnchor = CreateFrame('Frame', nil, rosterContent)
  rightAnchor:SetPoint('TOPLEFT', 16 + COLUMN_WIDTH + 20, -ROSTER_CONTENT_TOP)
  rightAnchor:SetSize(1, 1)
  frame.rightAnchor = rightAnchor

  frame.tanksHeader   = makeSectionHeader(rosterContent)
  frame.meleeHeader   = makeSectionHeader(rosterContent)
  frame.healersHeader = makeSectionHeader(rosterContent)
  frame.rangedHeader  = makeSectionHeader(rosterContent)
  frame.outHeader     = makeSectionHeader(rosterContent)

  frame.tanksHeader:SetPoint('TOPLEFT', leftAnchor, 'TOPLEFT', 0, 0)
  frame.healersHeader:SetPoint('TOPLEFT', rightAnchor, 'TOPLEFT', 0, 0)

  if RaidLead.UI.BuildLootContent then RaidLead.UI.BuildLootContent(frame, lootContent, CONTENT_TOP) end

  return frame
end

UI.EnsureFrame = ensureFrame

function UI.Toggle()
  local f = ensureFrame()
  if f:IsShown() then f:Hide() else f:Show() end
end

function UI.Update(data)
  local f = ensureFrame()
  releaseAllPills()

  if not data then
    f.title:SetText('RaidLead — no published roster synced yet')
    f.tanksHeader:SetText('')
    f.healersHeader:SetText('')
    f.meleeHeader:SetText('')
    f.rangedHeader:SetText('')
    f.outHeader:SetText('')
    f.missingEntries = {}
    f.allNames = {}
    f.inviteBtn:Hide()
    f.disbandBtn:Hide()
    return
  end

  f.title:SetText(data.planName or 'Tonight\'s Roster')

  local missingEntries = {}
  local function collectMissing(entries)
    for _, e in ipairs(entries) do
      if not e.inGroup then table.insert(missingEntries, { name = e.name, server = e.server, realmName = e.realmName }) end
    end
  end

  f.tanksHeader:SetText(string.format('TANKS (%d)', #data.columns.tanks))
  local lastLeft = layoutSection(f.rosterContent, f.tanksHeader, data.columns.tanks)
  collectMissing(data.columns.tanks)

  f.meleeHeader:ClearAllPoints()
  f.meleeHeader:SetPoint('TOPLEFT', lastLeft, 'BOTTOMLEFT', 0, -SECTION_GAP)
  f.meleeHeader:SetText(string.format('MELEE (%d)', #data.columns.melee))
  local lastLeftBottom = layoutSection(f.rosterContent, f.meleeHeader, data.columns.melee)
  collectMissing(data.columns.melee)

  f.healersHeader:SetText(string.format('HEALERS (%d)', #data.columns.healers))
  local lastRight = layoutSection(f.rosterContent, f.healersHeader, data.columns.healers)
  collectMissing(data.columns.healers)

  f.rangedHeader:ClearAllPoints()
  f.rangedHeader:SetPoint('TOPLEFT', lastRight, 'BOTTOMLEFT', 0, -SECTION_GAP)
  f.rangedHeader:SetText(string.format('RANGED (%d)', #data.columns.ranged))
  local lastRightBottom = layoutSection(f.rosterContent, f.rangedHeader, data.columns.ranged)
  collectMissing(data.columns.ranged)

  f.missingEntries = missingEntries
  f.allNames = data.allNames or {}
  local canInvite = RaidLead.CanInvite()
  f.inviteBtn:SetShown(canInvite and #missingEntries > 0)
  f.disbandBtn:SetShown(canInvite and #f.allNames > 0)

  -- Out/Unavailable strip, full width, anchored below whichever column
  -- (Tanks+Melee vs. Healers+Ranged) actually ran lower on screen -- can't
  -- just assume one side, since a raid can easily have more ranged/healers
  -- than tanks/melee (or vice versa on an odd comp).
  local frameTop = frame:GetTop() or 0
  local leftBottom  = lastLeftBottom:GetBottom()  or frameTop
  local rightBottom = lastRightBottom:GetBottom() or frameTop
  local lowestBottom = math.min(leftBottom, rightBottom)

  f.outHeader:ClearAllPoints()
  f.outHeader:SetPoint('TOPLEFT', frame, 'TOPLEFT', 16, -(frameTop - lowestBottom) - SECTION_GAP)
  f.outHeader:SetText(string.format('OUT / UNAVAILABLE (%d)', #data.unavailable))

  local prevAnchor, prevRelPoint = f.outHeader, 'BOTTOMLEFT'
  for _, entry in ipairs(data.unavailable) do
    local pill = acquirePill(f.rosterContent)
    pill:SetSize(COLUMN_WIDTH * 2 + 20, PILL_HEIGHT)
    pill:ClearAllPoints()
    pill:SetPoint('TOPLEFT', prevAnchor, prevRelPoint, 0, -PILL_GAP)
    pill:SetBackdropColor(0.3, 0.08, 0.08, 0.6)
    pill.text:SetText(entry.name or '?')
    pill.dot:SetColorTexture(0.7, 0.2, 0.2, 1)
    applyStatusDot(pill, entry.isOnline)
    prevAnchor, prevRelPoint = pill, 'BOTTOMLEFT'
  end

  -- The Out/Unavailable strip can run to any length depending on how many
  -- people are marked out for a given night -- rather than clipping it or
  -- building a full ScrollFrame, just grow the window to fit whatever got
  -- laid out. CENTER-anchored, so growing shifts the frame slightly on
  -- screen; accepted tradeoff for a much simpler implementation.
  local lastBottom = prevAnchor:GetBottom() or lowestBottom
  frame:SetHeight(math.max(FRAME_MIN_HEIGHT, (frameTop - lastBottom) + FRAME_BOTTOM_PADDING))
end
