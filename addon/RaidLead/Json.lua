-- ============================================================
-- Json.lua — minimal, dependency-free JSON encode/decode.
--
-- The addon and the companion app hand data back and forth as SavedVariables,
-- but SavedVariables files are Lua syntax, not JSON. Rather than have the
-- companion app embed a Lua table parser (or the addon embed a full Lua
-- table generator the companion app would then have to re-derive), both
-- sides agree to store their payload as a single JSON string inside one
-- Lua field. That means the companion app only ever needs a JSON parser
-- (every language has one built in or a one-file library), and the addon
-- needs this small encode/decode pair. Handles the plain data shapes this
-- addon actually produces: strings, numbers, booleans, nil, and nested
-- arrays/objects -- not a general-purpose JSON library.
-- ============================================================
local _, RaidLead = ...
RaidLead.Json = {}
local Json = RaidLead.Json

local ESCAPES = {
  ['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t',
}

local function encodeString(s)
  return '"' .. s:gsub('[%c"\\]', function(c) return ESCAPES[c] or string.format('\\u%04x', c:byte()) end) .. '"'
end

local function isArray(t)
  local n = 0
  for _ in pairs(t) do n = n + 1 end
  for i = 1, n do
    if t[i] == nil then return false end
  end
  return n > 0 or next(t) == nil
end

local encodeValue

local function encodeArray(t)
  local parts = {}
  for i = 1, #t do parts[i] = encodeValue(t[i]) end
  return '[' .. table.concat(parts, ',') .. ']'
end

local function encodeObject(t)
  local parts = {}
  for k, v in pairs(t) do
    parts[#parts + 1] = encodeString(tostring(k)) .. ':' .. encodeValue(v)
  end
  return '{' .. table.concat(parts, ',') .. '}'
end

encodeValue = function(v)
  local kind = type(v)
  if kind == 'string' then return encodeString(v)
  elseif kind == 'number' then return (v ~= v or v == math.huge or v == -math.huge) and 'null' or tostring(v)
  elseif kind == 'boolean' then return tostring(v)
  elseif kind == 'table' then return isArray(v) and encodeArray(v) or encodeObject(v)
  else return 'null' end
end

function Json.encode(value)
  return encodeValue(value)
end

-- ── Decode ──────────────────────────────────────────────────
-- A small recursive-descent parser. Only used to read data the companion
-- app wrote, which is always well-formed JSON it generated itself.

local function skipWhitespace(s, i)
  local _, stop = s:find('^%s*', i)
  return stop + 1
end

local decodeValue

local function decodeString(s, i)
  assert(s:sub(i, i) == '"', 'expected string at ' .. i)
  local j = i + 1
  local out = {}
  while true do
    local c = s:sub(j, j)
    if c == '' then error('unterminated string') end
    if c == '"' then
      return table.concat(out), j + 1
    elseif c == '\\' then
      local nc = s:sub(j + 1, j + 1)
      if nc == 'n' then out[#out + 1] = '\n'
      elseif nc == 't' then out[#out + 1] = '\t'
      elseif nc == 'r' then out[#out + 1] = '\r'
      elseif nc == 'u' then
        local hex = s:sub(j + 2, j + 5)
        out[#out + 1] = string.char(tonumber(hex, 16) % 256)
        j = j + 4
      else out[#out + 1] = nc end
      j = j + 2
    else
      out[#out + 1] = c
      j = j + 1
    end
  end
end

local function decodeNumber(s, i)
  local numStr = s:match('^-?%d+%.?%d*[eE]?[+-]?%d*', i)
  return tonumber(numStr), i + #numStr
end

local function decodeArray(s, i)
  local arr = {}
  i = skipWhitespace(s, i + 1)
  if s:sub(i, i) == ']' then return arr, i + 1 end
  while true do
    local v
    v, i = decodeValue(s, i)
    arr[#arr + 1] = v
    i = skipWhitespace(s, i)
    local c = s:sub(i, i)
    if c == ',' then i = skipWhitespace(s, i + 1)
    elseif c == ']' then return arr, i + 1
    else error('expected , or ] at ' .. i) end
  end
end

local function decodeObject(s, i)
  local obj = {}
  i = skipWhitespace(s, i + 1)
  if s:sub(i, i) == '}' then return obj, i + 1 end
  while true do
    local key
    key, i = decodeString(s, i)
    i = skipWhitespace(s, i)
    assert(s:sub(i, i) == ':', 'expected : at ' .. i)
    i = skipWhitespace(s, i + 1)
    local v
    v, i = decodeValue(s, i)
    obj[key] = v
    i = skipWhitespace(s, i)
    local c = s:sub(i, i)
    if c == ',' then i = skipWhitespace(s, i + 1)
    elseif c == '}' then return obj, i + 1
    else error('expected , or } at ' .. i) end
  end
end

decodeValue = function(s, i)
  i = skipWhitespace(s, i)
  local c = s:sub(i, i)
  if c == '"' then return decodeString(s, i)
  elseif c == '{' then return decodeObject(s, i)
  elseif c == '[' then return decodeArray(s, i)
  elseif s:sub(i, i + 3) == 'true' then return true, i + 4
  elseif s:sub(i, i + 4) == 'false' then return false, i + 5
  elseif s:sub(i, i + 3) == 'null' then return nil, i + 4
  else return decodeNumber(s, i) end
end

-- Returns nil (and logs, never throws) on malformed input -- a bad companion
-- payload should never be able to break the addon.
function Json.decode(str)
  if type(str) ~= 'string' or str == '' then return nil end
  local ok, value = pcall(function()
    local v = decodeValue(str, 1)
    return v
  end)
  if not ok then
    return nil
  end
  return value
end
