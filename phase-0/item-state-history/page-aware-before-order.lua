-- Separate read-only supplement. Missing reads/keys never become defaults.
-- Graph counts identify neither graph contents nor persistent graph/node IDs.
local function object() return setmetatable({}, {__object = true}) end
local NULL = {}
local specs = {
  speed = {Percentage = 'decimal', PitchCorrection = 'boolean', StretchKeyframesToFit = 'boolean', RippleTimeline = 'boolean'},
  fades = {FadeIn = 'integer', FadeOut = 'integer'},
  outputBlanking = {Top = 'integer', Bottom = 'integer', Left = 'integer', Right = 'integer'}
}
local function number(value, nonnegative)
  if type(value) ~= 'number' or value ~= value or value == math.huge or value == -math.huge
    or math.abs(value) > 9007199254740991 or (nonnegative and value < 0) then error('Invalid observed number') end
end
local function value_for(value, kind)
  if kind == 'boolean' then
    if type(value) ~= 'boolean' then error('Invalid observed boolean') end
    return value
  end
  number(value, false)
  if kind == 'integer' then
    if value % 1 ~= 0 then error('Invalid observed integer') end
    return value
  end
  return {decimal = string.format('%.16e', value)}
end
local function observed(action, kind)
  local ok, raw = pcall(action)
  if not ok or raw == nil then return {status = 'unavailable', value = NULL} end
  if specs[kind] then
    if type(raw) ~= 'table' then error('Invalid observed dictionary') end
    local result = object()
    for name, value in pairs(raw) do
      if name ~= '__flags' then
        local expected = specs[kind][name]
        if expected == nil then error('Undocumented observed field') end
        result[name] = value_for(value, expected)
      end
    end
    return {status = 'captured', value = result}
  end
  if kind == 'count' then number(raw, true); if raw % 1 ~= 0 then error('Invalid observed count') end
  else raw = value_for(raw, kind) end
  return {status = 'captured', value = raw}
end
local function active_id(project)
  local timeline = project:GetCurrentTimeline()
  return timeline and timeline:GetUniqueId() or NULL
end
local function current_page(resolve)
  local ok, page = pcall(function() return resolve:GetCurrentPage() end)
  if not ok or page == nil then return NULL end
  if page ~= 'media' and page ~= 'photo' and page ~= 'cut' and page ~= 'edit' and page ~= 'fusion'
    and page ~= 'color' and page ~= 'fairlight' and page ~= 'deliver' then error('Invalid page context') end
  return page
end
local function read_once(resolve, base, page)
  local project = resolve:GetProjectManager():GetCurrentProject()
  local records = base.array()
  for index = 1, project:GetTimelineCount() do
    local timeline = project:GetTimelineByIndex(index)
    local timeline_id = timeline:GetUniqueId()
    for _, kind in ipairs({'video', 'audio', 'subtitle'}) do
      for track = 1, timeline:GetTrackCount(kind) do
        for _, item in ipairs(timeline:GetItemListInTrack(kind, track) or {}) do
          records[#records + 1] = {
            timelineId = timeline_id, itemId = item:GetUniqueId(),
            clipEnabled = observed(function() return item:GetClipEnabled() end, 'boolean'),
            speed = observed(function() return item:GetSpeed() end, 'speed'),
            fades = observed(function() return item:GetFades() end, 'fades'),
            outputBlanking = observed(function() return item:GetOutputBlanking() end, 'outputBlanking'),
            usesTimelineOutputBlanking = observed(function() return item:GetUseTimelineForOutputBlanking() end, 'boolean'),
            fusionCompCount = observed(function() return item:GetFusionCompCount() end, 'count'),
            firstColorLayerNodeCount = observed(function()
              -- GetNodeGraph was observed to navigate from Edit to Color.
              -- Never invoke it as an automatic cross-page capability probe.
              if page ~= 'color' then return nil end
              local graph = item:GetNodeGraph()
              if graph == nil then return nil end
              return graph:GetNumNodes()
            end, 'count')
          }
        end
      end
    end
  end
  table.sort(records, function(a,b) if a.timelineId ~= b.timelineId then return a.timelineId < b.timelineId end; return a.itemId < b.itemId end)
  return records
end
local function capture(resolve, base, encode, max_items)
  if type(max_items) ~= 'number' or max_items < 1 or max_items > 200 or max_items % 1 ~= 0 then error('Invalid item-state bound') end
  local project = resolve:GetProjectManager():GetCurrentProject()
  if project == nil then error('Open a disposable project') end
  local page = current_page(resolve)
  -- Count before the expensive per-item base capture. Never truncate a project.
  local count, track_count = 0, 0
  local timeline_count = project:GetTimelineCount()
  number(timeline_count, true)
  if timeline_count % 1 ~= 0 or timeline_count > 20 then error('Item-state timeline bound exceeded') end
  for index = 1, timeline_count do
    local timeline = project:GetTimelineByIndex(index)
    for _, kind in ipairs({'video', 'audio', 'subtitle'}) do
      local tracks = timeline:GetTrackCount(kind)
      number(tracks, true)
      if tracks % 1 ~= 0 or tracks + track_count > 200 then error('Item-state track bound exceeded') end
      track_count = track_count + tracks
      for track = 1, tracks do
        local list = timeline:GetItemListInTrack(kind, track) or {}
        local entries = 0
        for key in pairs(list) do
          if type(key) == 'number' and key >= 1 and key % 1 == 0 then entries = entries + 1
          elseif key ~= '__flags' then error('Invalid item-state list') end
        end
        if entries ~= #list then error('Sparse item-state list') end
        count = count + entries
        if count > max_items then error('Item-state project exceeds bound') end
      end
    end
  end
  local snapshot = base.capture(resolve)
  local active = active_id(project)
  local items = read_once(resolve, base, page)
  local repeated = read_once(resolve, base, page)
  if encode(page) ~= encode(current_page(resolve)) then error('Page context changed during item-state capture') end
  if encode(items) ~= encode(repeated) then error('Item state changed during capture') end
  if base.encode(snapshot) ~= base.encode(base.capture(resolve)) then error('Snapshot context changed during item-state capture') end
  if encode(active) ~= encode(active_id(project)) then error('Active timeline context changed during item-state capture') end
  if #items ~= count then error('Item-state membership changed') end
  return {schemaVersion = 1, operation = 'resolve-item-state-observation', readOnly = true, safeToApply = false,
    snapshot = snapshot, activeTimelineId = active, items = items, capturePasses = 2,
    representedStateUnchangedAcrossReads = true, colorGraphScope = 'first-layer-count-only',
    capturePage = page, colorGraphReadPolicy = 'color-page-only'}
end

return {capture = capture}
