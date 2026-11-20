-- Read-only menu capture of the represented schema-3 state. No save/load/write
-- editor calls, timeline selection changes, or fixture creation are performed.
local expected_name = __EXPECTED_PROJECT_NAME__
local probe_id = __PROBE_ID__
local result_path = __RESULT_PATH__
local complete_path = __COMPLETE_PATH__

local ok = pcall(function()
  assert(resolve ~= nil and resolve:GetVersionString() == '21.1.2.10', 'Unexpected Resolve version')
  assert(resolve:GetProjectManager():GetCurrentProject():GetName() == expected_name, 'Unexpected disposable project')
  local fusion = assert(resolve:Fusion(), 'Fusion unavailable')
  assert(type(fusion.OpenFile) == 'function', 'Fusion file access unavailable')
  local function absent(filename)
    local previous = fusion:OpenFile(filename, 1)
    if previous ~= nil then previous:Close(); error('Inventory output already exists') end
  end
  absent(result_path)
  absent(complete_path)
  local base = (function()
__BASE_CAPTURE_SOURCE__
  end)()
  local function cpu_clock()
    if type(os) == 'table' and type(os.clock) == 'function' then
      local success, value = pcall(os.clock)
      if success and type(value) == 'number' and value == value and value >= 0 and value < math.huge then return value end
    end
    return nil
  end
  local cpu_start = cpu_clock()
  local snapshot = base.capture(resolve)
  local first_bytes = base.encode(snapshot)
  assert(#first_bytes <= 20 * 1024 * 1024, 'Inventory exceeds limit')
  local second_bytes = base.encode(base.capture(resolve))
  assert(second_bytes == first_bytes, 'Represented project state changed during capture')
  assert(snapshot.project_name == expected_name and snapshot.resolve_version == '21.1.2.10', 'Inventory target changed')
  local cpu_end = cpu_clock()
  local result = {schemaVersion = 1, operation = 'resolve-menu-inventory', probeId = probe_id,
    readOnly = true, safeToApply = false, snapshot = snapshot, capturePasses = 2,
    representedStateUnchangedAcrossReads = true, cpuTimeStatus = 'unavailable'}
  if cpu_start ~= nil and cpu_end ~= nil and cpu_end >= cpu_start then
    local micros = math.floor((cpu_end - cpu_start) * 1000000 + 0.5)
    if micros >= 0 and micros <= 9007199254740991 then result.cpuTimeStatus = 'captured'; result.cpuMicros = micros end
  end
  local payload = base.encode(result)
  assert(#payload + 1 <= 20 * 1024 * 1024, 'Inventory envelope exceeds limit')

  -- Reuses the Console-proven Fusion IOClass semantics, now independently
  -- observed in the menu runtime by resolve-menu-runtime-live-observation.json.
  local function write_and_verify(filename, value)
    absent(filename)
    local handle = assert(fusion:OpenFile(filename, 2), 'Inventory writer unavailable')
    local written = pcall(function()
      assert(handle:WriteLine(value) == #value + 1, 'Inventory write failed')
      assert(handle:Flush() == true, 'Inventory flush failed')
    end)
    local closed = pcall(function() handle:Close() end)
    assert(written and closed, 'Inventory write failed')
    local expected = value .. '\n'
    local reader = assert(fusion:OpenFile(filename, 1), 'Inventory reader unavailable')
    local read_ok, actual = pcall(function()
      assert(reader:GetFileSize() == #expected, 'Inventory size differs')
      local parts, count = {}, 0
      while count < #expected do
        local part = reader:ReadLine()
        assert(type(part) == 'string' and #part > 0 and #part <= #expected - count, 'Inventory read differs')
        count = count + #part
        parts[#parts + 1] = part
      end
      assert(reader:ReadLine() == nil and reader:GetFileSize() == #expected, 'Inventory EOF differs')
      return table.concat(parts)
    end)
    local read_closed = pcall(function() reader:Close() end)
    assert(read_ok and read_closed and actual == expected, 'Inventory readback differs')
  end
  write_and_verify(result_path, payload)
  write_and_verify(complete_path, 'FRAMELINE_MENU_INVENTORY_COMPLETE_V1:' .. probe_id)
  print('FRAMELINE_MENU_INVENTORY_OK_V1:' .. probe_id)
end)
if not ok then print('FRAMELINE_MENU_INVENTORY_FAILED_V1:' .. probe_id) end
