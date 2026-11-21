-- Read-only, exact-project item-state research handoff. No project writes.
local project_name = __PROJECT_NAME__
local project_id = __PROJECT_ID__
local request_id = __REQUEST_ID__
local result_path = __RESULT_PATH__
local observation_path = __OBSERVATION_PATH__
local marker_path = __MARKER_PATH__
local failure_path = __FAILURE_PATH__
local expected_snapshot
local fusion, encode, write_exact, guarded
local stage = 'guard'
local ok, err = pcall(function()
  assert(resolve and resolve:GetVersionString() == '21.1.2.10', 'Unexpected Resolve version')
  local project = assert(resolve:GetProjectManager():GetCurrentProject(), 'No project')
  assert(project:GetName() == project_name and project:GetUniqueId() == project_id, 'Wrong disposable project')
  guarded = true
  fusion = assert(resolve:Fusion(), 'No Fusion file runtime')
  local function absent(filename)
    local existing = fusion:OpenFile(filename, 1)
    if existing then existing:Close(); error('Output already exists') end
  end
  for _, filename in ipairs({result_path, observation_path, marker_path, failure_path}) do absent(filename) end
  write_exact = function(filename, value)
    absent(filename)
    assert(#value < 2 * 1024 * 1024, 'Output exceeds bound')
    local handle = assert(fusion:OpenFile(filename, 2), 'Writer unavailable')
    local written = pcall(function()
      assert(handle:WriteLine(value) == #value + 1, 'Write failed')
      assert(handle:Flush() == true, 'Flush failed')
    end)
    local closed = pcall(function() handle:Close() end)
    assert(written and closed, 'Write failed')
    local reader = assert(fusion:OpenFile(filename, 1), 'Readback unavailable')
    local read_ok, actual = pcall(function()
      assert(reader:GetFileSize() == #value + 1, 'Readback size differs')
      local parts, count = {}, 0
      while count < #value + 1 do
        local part = reader:ReadLine()
        assert(type(part) == 'string' and #part > 0 and #part <= #value + 1 - count, 'Readback failed')
        parts[#parts + 1] = part; count = count + #part
      end
      assert(reader:ReadLine() == nil, 'Readback grew')
      return table.concat(parts)
    end)
    local closed_read = pcall(function() reader:Close() end)
    assert(read_ok and closed_read and actual == value .. '\n', 'Readback differs')
  end
  local base = (function()
__BASE_SOURCE__
  end)()
  local effects = (function()
__EFFECT_SOURCE__
  end)()
  local state = (function()
__STATE_SOURCE__
  end)()
  encode = effects.encode
  expected_snapshot = __EXPECTED_SNAPSHOT__
  stage = 'capture'
  if expected_snapshot ~= nil then assert(base.encode(base.capture(resolve)) == base.encode(expected_snapshot), 'Expected snapshot changed') end
  local observed = state.capture(resolve, base, encode, 50)
  assert(observed.snapshot.project_id == project_id and observed.snapshot.project_name == project_name, 'Project context changed')
  assert(#observed.items == 50 and #observed.snapshot.timelines == 1 and #observed.snapshot.timelines[1].tracks == 5, 'Unexpected fixture shape')
  if expected_snapshot ~= nil then assert(base.encode(observed.snapshot) == base.encode(expected_snapshot), 'Expected snapshot changed') end
  local bytes = encode(observed)
  stage = 'observation-write'; write_exact(observation_path, bytes)
  stage = 'result-write'; write_exact(result_path, encode({schemaVersion = 1, operation = 'resolve-item-state-menu',
    requestId = request_id, readOnly = true, safeToApply = false, projectId = project_id,
    itemCount = #observed.items, observationBytes = #bytes}))
  stage = 'marker-write'; write_exact(marker_path, 'FRAMELINE_ITEM_STATE_MENU_COMPLETE_V1:' .. request_id)
  print('FRAMELINE_ITEM_STATE_MENU_OK_V1:' .. request_id)
end)
if not ok then
  -- Only static codes leave the runtime. Raw exceptions may contain local paths.
  local code = 'capture-failed'
  if stage ~= 'capture' and stage ~= 'guard' then code = 'output-failed'
  elseif type(err) == 'string' and err:find('Undocumented observed field', 1, true) then code = 'unsupported-field'
  elseif type(err) == 'string' and err:find('Invalid observed', 1, true) then code = 'invalid-value'
  elseif type(err) == 'string' and err:find('exceeds bound', 1, true) then code = 'oversize'
  elseif type(err) == 'string' and err:find('Expected snapshot changed', 1, true) then code = 'expected-snapshot-diverged'
  elseif type(err) == 'string' and err:find('Item state changed during capture', 1, true) then code = 'item-state-diverged'
  elseif type(err) == 'string' and err:find('Page context changed', 1, true) then code = 'page-context-diverged'
  elseif type(err) == 'string' and err:find('Snapshot context changed', 1, true) then code = 'snapshot-context-diverged'
  elseif type(err) == 'string' and err:find('Active timeline context changed', 1, true) then code = 'timeline-context-diverged'
  elseif type(err) == 'string' and err:find('membership changed', 1, true) then code = 'membership-diverged'
  elseif type(err) == 'string' and err:find('changed', 1, true) then code = 'state-changed' end
  if guarded and write_exact and encode then pcall(function()
    write_exact(failure_path, encode({schemaVersion = 1, operation = 'resolve-item-state-menu-failure',
      requestId = request_id, readOnly = true, safeToApply = false, stage = stage, errorCode = code}))
  end) end
  print('FRAMELINE_ITEM_STATE_MENU_FAILED_V1:' .. request_id)
end
