-- Disposable read-only editor probe. The Node preparer replaces these tokens.
-- It never saves, loads, closes, renames or otherwise mutates a project.
local expected_name = __EXPECTED_PROJECT_NAME__
local probe_id = __PROBE_ID__
local result_path = __RESULT_PATH__
local complete_path = __COMPLETE_PATH__

local ok = pcall(function()
  assert(resolve ~= nil, 'Resolve unavailable')
  assert(resolve:GetVersionString() == '21.1.2.10', 'Unexpected Resolve version')
  local fusion = assert(resolve:Fusion(), 'Fusion unavailable')
  assert(type(fusion.OpenFile) == 'function', 'Fusion file access unavailable')

  -- IOClass has no documented exclusive-create mode. Check both unguessable
  -- names first in the preparer's fresh mode-0700 directory. A later invocation
  -- refuses existing output. This does not claim atomic filesystem exclusion.
  local function absent(filename)
    local previous = fusion:OpenFile(filename, 1)
    if previous ~= nil then previous:Close(); error('Probe output already exists') end
  end
  absent(result_path)
  absent(complete_path)

  local project = assert(resolve:GetProjectManager():GetCurrentProject(), 'Project unavailable')
  assert(project:GetName() == expected_name, 'Unexpected disposable project')
  local project_id = project:GetUniqueId()
  assert(type(project_id) == 'string' and #project_id > 0 and #project_id <= 160
    and not project_id:find('[^A-Za-z0-9_.%-]'), 'Invalid project ID')
  local timeline_count = project:GetTimelineCount()
  assert(type(timeline_count) == 'number' and timeline_count >= 0 and timeline_count <= 100000
    and timeline_count % 1 == 0, 'Invalid timeline count')
  local standard_io = type(io) == 'table' and type(io.open) == 'function'
  local payload = '{"schemaVersion":1,"operation":"resolve-menu-runtime-probe","probeId":"' .. probe_id
    .. '","readOnly":true,"safeToApply":false,"resolveVersion":"21.1.2.10","projectName":"'
    .. expected_name .. '","projectId":"' .. project_id .. '","timelineCount":' .. string.format('%.0f', timeline_count)
    .. ',"standardLuaIoAvailable":' .. tostring(standard_io) .. ',"fusionOpenFileAvailable":true}'
  assert(#payload < 4096, 'Probe result too large')

  -- Numeric modes, byte count including LF, Flush and void Close are empirical
  -- behavior pinned by resolve-result-writer-live-observation.json. The SDK
  -- documents Resolve.Fusion and the project getters; no write API is called.
  local function write_and_verify(filename, value)
    absent(filename)
    local handle = assert(fusion:OpenFile(filename, 2), 'Probe writer unavailable')
    local written = pcall(function()
      assert(handle:WriteLine(value) == #value + 1, 'Probe write failed')
      assert(handle:Flush() == true, 'Probe flush failed')
    end)
    local closed = pcall(function() handle:Close() end)
    assert(written and closed, 'Probe write failed')
    local expected = value .. '\n'
    local reader = assert(fusion:OpenFile(filename, 1), 'Probe reader unavailable')
    local read_ok, actual = pcall(function()
      assert(reader:GetFileSize() == #expected, 'Probe size differs')
      local parts, count = {}, 0
      while count < #expected do
        local part = reader:ReadLine()
        assert(type(part) == 'string' and #part > 0 and #part <= #expected - count, 'Probe read differs')
        count = count + #part
        parts[#parts + 1] = part
      end
      assert(reader:ReadLine() == nil and reader:GetFileSize() == #expected, 'Probe EOF differs')
      return table.concat(parts)
    end)
    local read_closed = pcall(function() reader:Close() end)
    assert(read_ok and read_closed and actual == expected, 'Probe readback differs')
  end
  write_and_verify(result_path, payload)
  -- This distinct marker is written only after exact result readback. A host
  -- accepts neither a partial result nor a marker from another prepared run.
  write_and_verify(complete_path, 'FRAMELINE_MENU_PROBE_COMPLETE_V1:' .. probe_id)
  print('FRAMELINE_MENU_PROBE_OK_V1:' .. probe_id)
end)
if not ok then print('FRAMELINE_MENU_PROBE_FAILED_V1:' .. probe_id) end
