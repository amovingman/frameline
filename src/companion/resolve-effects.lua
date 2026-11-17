-- Read-only supplement to the schema-3 capture. Effect type IDs identify
-- catalogue entries; their category/index does not establish instance identity.
local function capture_effects(resolve, base)
  local snapshot = base.capture(resolve)
  local project = resolve:GetProjectManager():GetCurrentProject()
  local items = base.array()
  for timeline_index = 1, project:GetTimelineCount() do
    local timeline = project:GetTimelineByIndex(timeline_index)
    for _, track_type in ipairs({'video', 'audio', 'subtitle'}) do
      for track_index = 1, timeline:GetTrackCount(track_type) do
        for _, item in ipairs(timeline:GetItemListInTrack(track_type, track_index) or {}) do
          local effects = base.array()
          for _, category in ipairs({'fusion', 'ofx', 'audio'}) do
            local list = item:GetEffects(category) or {}
            local count = 0
            for key in pairs(list) do
              if type(key) == 'number' and key >= 1 and key % 1 == 0 then count = count + 1
              elseif key ~= '__flags' then error('Unsupported effects list') end
            end
            local observed = 0
            for _, effect in ipairs(list) do
              local info = effect:GetInfo()
              if type(info) ~= 'table' or info.category ~= category then error('Effect information unavailable') end
              local enabled, index = effect:GetIsEnabled(), effect:GetIndex()
              if type(enabled) ~= 'boolean' or type(index) ~= 'number' or index < 1 or index % 1 ~= 0 then
                error('Effect state unavailable')
              end
              effects[#effects + 1] = {category = category, index = index, typeId = info.id,
                name = info.name, enabled = enabled}
              observed = observed + 1
            end
            if observed ~= count then error('Sparse effects list') end
          end
          items[#items + 1] = {timelineId = timeline:GetUniqueId(), itemId = item:GetUniqueId(), effects = effects}
        end
      end
    end
  end
  if base.encode(base.capture(resolve)) ~= base.encode(snapshot) then error('Project changed during effect capture') end
  return {schemaVersion = 1, operation = 'resolve-effect-observation', readOnly = true,
    safeToApply = false, snapshot = snapshot, items = items}
end

-- Catalogue IDs contain slashes. The Node validator separately restricts these
-- values to known catalogue prefixes; snapshot and display fields reject paths.
local function quote(value)
  if type(value) ~= 'string' or value:find('[%z\1-\31\127]') then error('Invalid capture text') end
  return '"' .. value:gsub('\\', '\\\\'):gsub('"', '\\"') .. '"'
end
local function encode(value)
  if type(value) == 'string' then return quote(value) end
  if type(value) == 'boolean' then return value and 'true' or 'false' end
  if type(value) == 'number' then
    if value ~= value or value == math.huge or value == -math.huge or value % 1 ~= 0 then error('Invalid integer') end
    return string.format('%.0f', value)
  end
  if type(value) ~= 'table' then error('Unsupported capture value') end
  -- The base capture's null sentinel is an empty table without a metatable.
  if next(value) == nil and getmetatable(value) == nil then return 'null' end
  local parts = {}
  if getmetatable(value) and getmetatable(value).__array then
    for index = 1, #value do parts[#parts + 1] = encode(value[index]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do parts[#parts + 1] = quote(key) .. ':' .. encode(value[key]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

return {capture = capture_effects, encode = encode}
