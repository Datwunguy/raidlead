-- ============================================================
-- UI/LootFrame.lua — the Loot pane: a live list of everything captured
-- this session (item -> recipient), plus a "Prepare for Sync" button.
--
-- Loaded after Core.lua/Loot.lua/RosterFrame.lua, and hooks into the
-- shared window RosterFrame.lua builds via RaidLead.UI.BuildLootContent,
-- called once from that file's ensureFrame().
--
-- Why "Prepare for Sync" reloads the UI rather than uploading directly:
-- no WoW addon can make a network call, ever, regardless of what triggers
-- it (logout included) -- the actual upload always happens through the
-- browser on RaidLead's Loot tab. What this button *can* do is force
-- WoW to flush this session's data to disk right now (via ReloadUI(),
-- same effect as typing /reload) instead of waiting for the player to
-- naturally reload or log out, so the freshest data is ready whenever
-- they do go sync it on the website.
-- ============================================================
local _, RaidLead = ...
RaidLead.UI = RaidLead.UI or {}
local UI = RaidLead.UI

local ROW_HEIGHT = 22
local ROW_GAP = 4
local MAX_VISIBLE_ROWS = 16

StaticPopupDialogs['RAIDLEAD_CONFIRM_RELOAD'] = {
  text = 'Reload your UI now to save this session\'s loot to disk?\n\nAfter reloading, go to RaidLead\'s Loot tab on the website and click Sync Now to actually upload it.',
  button1 = 'Reload Now',
  button2 = 'Cancel',
  OnAccept = function() ReloadUI() end,
  timeout = 0,
  whileDead = true,
  hideOnEscape = true,
  preferredIndex = 3,
}

local rowPool = {}
local rowsInUse = {}

local function makeRow(parent)
  local row = CreateFrame('Frame', nil, parent, 'BackdropTemplate')
  row:SetSize(438, ROW_HEIGHT)
  row:SetBackdrop({ bgFile = 'Interface\\Buttons\\WHITE8x8' })
  row:SetBackdropColor(1, 1, 1, 0.04)

  local left = row:CreateFontString(nil, 'OVERLAY', 'GameFontNormalSmall')
  left:SetPoint('LEFT', 8, 0)
  left:SetJustifyH('LEFT')
  left:SetWidth(280)
  row.left = left

  local right = row:CreateFontString(nil, 'OVERLAY', 'GameFontNormalSmall')
  right:SetPoint('RIGHT', -8, 0)
  right:SetJustifyH('RIGHT')
  right:SetTextColor(0.8, 0.8, 0.85)
  row.right = right

  return row
end

local function acquireRow(parent)
  local row = table.remove(rowPool)
  if not row then row = makeRow(parent) end
  row:SetParent(parent)
  row:Show()
  table.insert(rowsInUse, row)
  return row
end

local function releaseAllRows()
  for _, row in ipairs(rowsInUse) do
    row:Hide()
    row:ClearAllPoints()
    table.insert(rowPool, row)
  end
  wipe(rowsInUse)
end

function UI.BuildLootContent(frame, lootContent, contentTop)
  -- header/button share one row at contentTop (clear of the tab row above
  -- it), and the list starts a further ROW_HEIGHT+margin below that --
  -- these were overlapping the tabs before because this row was placed
  -- *above* contentTop instead of at-or-below it.
  local header = lootContent:CreateFontString(nil, 'OVERLAY', 'GameFontNormalSmall')
  header:SetPoint('TOPLEFT', 16, -contentTop - 4)
  header:SetTextColor(1, 0.82, 0.1)
  lootContent.header = header

  local syncBtn = CreateFrame('Button', nil, lootContent, 'UIPanelButtonTemplate')
  syncBtn:SetSize(170, 22)
  syncBtn:SetPoint('TOPRIGHT', -16, -contentTop + 3)
  syncBtn:SetText('Prepare Loot for Sync')
  syncBtn:SetScript('OnClick', function() StaticPopup_Show('RAIDLEAD_CONFIRM_RELOAD') end)

  local list = CreateFrame('Frame', nil, lootContent)
  list:SetPoint('TOPLEFT', 16, -contentTop - ROW_HEIGHT - 14)
  list:SetSize(438, 1)
  lootContent.list = list

  local footer = lootContent:CreateFontString(nil, 'OVERLAY', 'GameFontDisableSmall')
  footer:SetPoint('BOTTOM', 0, 14)
  lootContent.footer = footer
end

-- Every recorded loot item for the *current* session only, newest first.
local function currentSessionRecords()
  local records = {}
  for _, record in pairs(RaidLeadDB.lootRecords or {}) do
    if record.sessionId == RaidLead.sessionId then table.insert(records, record) end
  end
  table.sort(records, function(a, b) return (a.capturedAt or 0) > (b.capturedAt or 0) end)
  return records
end

function UI.RefreshLoot()
  local f = RaidLead.UI.EnsureFrame()
  local content = f.lootContent
  releaseAllRows()

  local records = currentSessionRecords()
  content.header:SetText(string.format('THIS SESSION (%d item%s)', #records, #records == 1 and '' or 's'))

  local prevAnchor, prevRelPoint = content.list, 'TOPLEFT'
  for i, record in ipairs(records) do
    if i > MAX_VISIBLE_ROWS then break end
    local row = acquireRow(content.list)
    row:ClearAllPoints()
    row:SetPoint('TOPLEFT', prevAnchor, prevRelPoint, 0, i == 1 and 0 or -ROW_GAP)

    local tag = record.isTierToken and '|cffc8a84bTier|r ' or (record.isBoe and '|cff888888BoE|r ' or '')
    row.left:SetText(string.format('%s%s  |cff888888(%s)|r', tag, record.itemName or ('Item ' .. tostring(record.itemId)), record.bossName or 'Trash'))
    row.right:SetText(record.recipientName or '?')

    prevAnchor, prevRelPoint = row, 'BOTTOMLEFT'
  end

  content.footer:SetText(#records > MAX_VISIBLE_ROWS
    and string.format('+ %d more not shown', #records - MAX_VISIBLE_ROWS) or '')
end
