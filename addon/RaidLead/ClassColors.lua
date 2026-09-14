-- ============================================================
-- ClassColors.lua — the exact same class -> hex map as public/index.html's
-- CLASS_COLORS, copied verbatim rather than derived from Blizzard's
-- RAID_CLASS_COLORS token table, so the addon's roster pills can never
-- drift from what the website shows for the same character. Keys match
-- the lowercase "class" string the site already sends for each character
-- (see raid_plan_members -> characters.class), not WoW's internal class
-- tokens (e.g. "DEATHKNIGHT").
-- ============================================================
local _, RaidLead = ...

RaidLead.CLASS_COLORS = {
  ['death knight']  = { r = 0xC4/255, g = 0x1E/255, b = 0x3A/255 },
  ['demon hunter']  = { r = 0xA3/255, g = 0x30/255, b = 0xC9/255 },
  ['druid']         = { r = 0xFF/255, g = 0x7C/255, b = 0x0A/255 },
  ['evoker']        = { r = 0x33/255, g = 0x93/255, b = 0x7F/255 },
  ['hunter']        = { r = 0xAA/255, g = 0xD3/255, b = 0x72/255 },
  ['mage']          = { r = 0x69/255, g = 0xCC/255, b = 0xF0/255 },
  ['monk']          = { r = 0x00/255, g = 0xFC/255, b = 0xB8/255 },
  ['paladin']       = { r = 0xF4/255, g = 0x8C/255, b = 0xBA/255 },
  ['priest']        = { r = 0xFF/255, g = 0xFF/255, b = 0xFF/255 },
  ['rogue']         = { r = 0xFF/255, g = 0xF4/255, b = 0x68/255 },
  ['shaman']        = { r = 0x44/255, g = 0x6A/255, b = 0xE3/255 },
  ['warrior']       = { r = 0xC7/255, g = 0x9C/255, b = 0x6E/255 },
  ['warlock']       = { r = 0x94/255, g = 0x82/255, b = 0xC9/255 },
}

local FALLBACK = { r = 0.53, g = 0.53, b = 0.53 } -- #888, same fallback the site uses

-- Returns { r, g, b } in 0-1 range, and a second value `muted` variant
-- (desaturated + dimmed) used for the "already in group" pill state.
function RaidLead.GetClassColor(class)
  local c = RaidLead.CLASS_COLORS[(class or ''):lower()] or FALLBACK
  return c
end

function RaidLead.GetMutedClassColor(class)
  local c = RaidLead.GetClassColor(class)
  -- Pull each channel toward a neutral grey and darken -- keeps a hint of the
  -- class tint (so it's still recognizably "them") while clearly reading as
  -- "handled, no action needed" next to a full-brightness missing pill.
  local grey = 0.4
  local pull = 0.6
  return {
    r = (c.r * (1 - pull) + grey * pull) * 0.7,
    g = (c.g * (1 - pull) + grey * pull) * 0.7,
    b = (c.b * (1 - pull) + grey * pull) * 0.7,
  }
end
