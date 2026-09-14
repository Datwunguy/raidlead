-- ============================================================
-- UI/MinimapButton.lua — a small, self-contained minimap icon (no
-- LibDBIcon/LibDataBroker -- those are the usual community libraries for
-- this, but embedding third-party code we can't run/verify here felt
-- riskier than a plain, well-understood drag-around-the-minimap-edge
-- frame). Left-click toggles the main window; position persists in
-- RaidLeadDB.minimap. `/raidlead minimap` toggles hiding it, for anyone
-- who'd rather just use the slash command.
-- ============================================================
local _, RaidLead = ...
RaidLead.UI = RaidLead.UI or {}

local ICON = 'Interface\\AddOns\\RaidLead\\Icon.png'
local SIZE = 26 -- other addons' minimap icons run closer to this than 31

local button

local function updatePosition(angleDegrees)
  local radius = (Minimap:GetWidth() / 2) + 5
  local radians = math.rad(angleDegrees)
  local x = math.cos(radians) * radius
  local y = math.sin(radians) * radius
  button:ClearAllPoints()
  button:SetPoint('CENTER', Minimap, 'CENTER', x, y)
end

local function create()
  -- BackdropTemplate here (not Blizzard's MiniMap-TrackingBorder texture,
  -- which turned out to have its ring drawn off-center within its own
  -- texture bounds -- fine when top-left-anchored the way Blizzard's own
  -- code expects, wrong when centered the way we tried). A plain backdrop
  -- border is geometry we fully control, so "fits inside the ring" is
  -- guaranteed rather than another guess at an undocumented texture.
  button = CreateFrame('Button', 'RaidLeadMinimapButton', Minimap, 'BackdropTemplate')
  button:SetSize(SIZE, SIZE)
  button:SetFrameStrata('MEDIUM')
  button:SetFrameLevel(8)
  button:RegisterForDrag('LeftButton')
  button:RegisterForClicks('LeftButtonUp')

  local icon = button:CreateTexture(nil, 'ARTWORK')
  icon:SetTexture(ICON)
  icon:SetPoint('TOPLEFT', 2, -2)
  icon:SetPoint('BOTTOMRIGHT', -2, 2)
  -- Crop in a bit so the icon's square corners don't poke out past the
  -- round-ish border drawn below.
  icon:SetTexCoord(0.1, 0.9, 0.1, 0.9)

  button:SetBackdrop({
    edgeFile = 'Interface\\Buttons\\WHITE8x8',
    edgeSize = 1,
  })
  button:SetBackdropBorderColor(0.78, 0.65, 0.2, 1) -- gold ring, matches the site's accent color

  button:SetScript('OnClick', function()
    if RaidLead.ToggleRosterFrame then RaidLead.ToggleRosterFrame() end
  end)

  button:SetScript('OnEnter', function(self)
    GameTooltip:SetOwner(self, 'ANCHOR_LEFT')
    GameTooltip:AddLine('RaidLead')
    GameTooltip:AddLine('|cffaaaaaaClick to open. Drag to move.|r')
    GameTooltip:Show()
  end)
  button:SetScript('OnLeave', function() GameTooltip:Hide() end)

  button:SetScript('OnDragStart', function(self) self:SetScript('OnUpdate', function()
    local mx, my = Minimap:GetCenter()
    local px, py = GetCursorPosition()
    local scale = Minimap:GetEffectiveScale()
    px, py = px / scale, py / scale
    local angle = math.deg(math.atan2(py - my, px - mx))
    updatePosition(angle)
    RaidLeadDB.minimap.angle = angle
  end) end)
  button:SetScript('OnDragStop', function(self) self:SetScript('OnUpdate', nil) end)

  updatePosition(RaidLeadDB.minimap.angle or 225)
  button:SetShown(not RaidLeadDB.minimap.hidden)
end

function RaidLead.UI.InitMinimapButton()
  if not button then create() end
end

function RaidLead.UI.SetMinimapButtonShown(shown)
  RaidLeadDB.minimap.hidden = not shown
  if button then button:SetShown(shown) end
end

RaidLead.RegisterOnPlayerLogin(RaidLead.UI.InitMinimapButton)
