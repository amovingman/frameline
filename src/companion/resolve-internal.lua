-- Read-only schema-3 capture for Resolve Free's internal Lua runtime.
-- Frameline validates the marked Console result against a private request.
local NULL = {}
local ARRAY = { __array = true }
local function array() return setmetatable({}, ARRAY) end

local function safe_text(value, nonempty)
  if type(value) ~= 'string' or (nonempty and value:match('^%s*$'))
    or value:find('[/\\%z\1-\31\127]') or value:match('^[A-Za-z]:') then
    error('Unsafe or missing Resolve text')
  end
  return value
end

local function quote(value)
  safe_text(value, false)
  local escaped = value:gsub('[%z\1-\31\\"]', function(character)
    if character == '"' then return '\\"' end
    if character == '\\' then return '\\\\' end
    return string.format('\\u%04x', character:byte())
  end)
  return '"' .. escaped .. '"'
end

local function encode(value)
  if value == NULL then return 'null' end
  local kind = type(value)
  if kind == 'string' then return quote(value) end
  if kind == 'boolean' then return value and 'true' or 'false' end
  if kind == 'number' then
    if value ~= value or value == math.huge or value == -math.huge or value % 1 ~= 0 then
      error('Non-integer Resolve value')
    end
    return string.format('%.0f', value)
  end
  if kind ~= 'table' then error('Unsupported Resolve value') end
  local parts = {}
  if getmetatable(value) == ARRAY then
    for index = 1, #value do parts[#parts + 1] = encode(value[index]) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for key in pairs(value) do
    safe_text(key, true)
    keys[#keys + 1] = key
  end
  table.sort(keys)
  for _, key in ipairs(keys) do parts[#parts + 1] = quote(key) .. ':' .. encode(value[key]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

local function count_entries(value)
  if value == nil then return 0 end
  if type(value) ~= 'table' then error('Invalid effects list') end
  local count = 0
  for key in pairs(value) do
    if type(key) == 'number' and key >= 1 and key % 1 == 0 then
      count = count + 1
    elseif key ~= '__flags' then
      error('Invalid effects list')
    end
  end
  return count
end

local function capture(resolve)
  local project = resolve:GetProjectManager():GetCurrentProject()
  if project == nil then error('Open a disposable Resolve project') end
  local timelines = array()
  local seen_timeline_ids = {}
  for timeline_index = 1, project:GetTimelineCount() do
    local timeline = project:GetTimelineByIndex(timeline_index)
    if timeline == nil then error('Timeline could not be read') end
    local timeline_id = safe_text(timeline:GetUniqueId(), true)
    if seen_timeline_ids[timeline_id] then error('Duplicate timeline ID') end
    seen_timeline_ids[timeline_id] = true
    local tracks, items, seen_ids = array(), array(), {}
    for _, track_type in ipairs({ 'video', 'audio', 'subtitle' }) do
      for track_index = 1, timeline:GetTrackCount(track_type) do
        tracks[#tracks + 1] = { type = track_type, index = track_index,
          name = safe_text(timeline:GetTrackName(track_type, track_index), false) }
        local track_items = timeline:GetItemListInTrack(track_type, track_index) or {}
        for _, item in ipairs(track_items) do
          local item_id = safe_text(item:GetUniqueId(), true)
          if seen_ids[item_id] then error('Duplicate item ID') end
          seen_ids[item_id] = true
          local media = item:GetMediaPoolItem()
          local linked_ids = array()
          for _, linked in ipairs(item:GetLinkedItems() or {}) do
            linked_ids[#linked_ids + 1] = safe_text(linked:GetUniqueId(), true)
          end
          table.sort(linked_ids)
          items[#items + 1] = {
            id = item_id, track_type = track_type, track_index = track_index,
            type = safe_text(item:GetType(), true), name = safe_text(item:GetName(), false),
            start_frame = item:GetStart() or NULL, end_frame = item:GetEnd() or NULL,
            source_start_frame = item:GetSourceStartFrame() or NULL,
            source_end_frame = item:GetSourceEndFrame() or NULL,
            media_pool_id = media and safe_text(media:GetUniqueId(), true) or NULL,
            linked_item_ids = linked_ids,
            effect_counts = {
              fusion = count_entries(item:GetEffects('fusion')),
              ofx = count_entries(item:GetEffects('ofx')),
              audio = count_entries(item:GetEffects('audio'))
            }
          }
        end
      end
    end
    timelines[#timelines + 1] = { id = timeline_id,
      name = safe_text(timeline:GetName(), false), start_frame = timeline:GetStartFrame(),
      tracks = tracks, items = items }
  end
  return { schema_version = 3, resolve_version = safe_text(resolve:GetVersionString(), true),
    project_id = safe_text(project:GetUniqueId(), true),
    project_name = safe_text(project:GetName(), true), timelines = timelines }
end

local function capture_request(resolve, request_id, request_sha, expected_name, expires_at)
  if not request_id:match('^[0-9a-f]+$') or #request_id ~= 32
    or not request_sha:match('^[0-9a-f]+$') or #request_sha ~= 64
    or type(expires_at) ~= 'number' or (os and os.time and os.time() * 1000 > expires_at) then
    error('Invalid or expired Frameline request')
  end
  if resolve:GetProjectManager():GetCurrentProject():GetName() ~= expected_name then
    error('Open the named disposable project before capturing')
  end
  local snapshot = capture(resolve)
  local response = encode({ schemaVersion = 1, operation = 'capture-result',
    requestId = request_id, requestSha256 = request_sha, snapshot = snapshot })
  if #response > 16384 then error('Capture exceeds Console transfer limit') end
  print('FRAMELINE_CAPTURE_RESULT_V1:' .. response)
  return { responseWritten = true, readOnly = true, safeToApply = false }
end

return { capture_request = capture_request }
