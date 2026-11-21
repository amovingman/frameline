-- OS clocks only; no Resolve project access or mutation.
local function finite(value)
  return type(value) == 'number' and value == value and value >= 0 and value < math.huge
end
local function delta_ns(before, after)
  if not before or not after then return nil end
  local value = (after.sec - before.sec) * 1000000000 + after.nano - before.nano
  if not finite(value) or value % 1 ~= 0 or value > 9007199254740991 then return nil end
  return value
end
local function open_clock()
  local clock = {description = {status = 'unavailable', id = 'unavailable', monotonic = false}}
  local loaded, ffi = pcall(function() return require('ffi') end)
  if loaded and ffi.os == 'OSX' and ffi.abi('64bit') then
    -- ABI and clock ID pinned to the installed macOS SDK _time.h and
    -- sys/_types/_timespec.h: CLOCK_MONOTONIC=6; time_t and tv_nsec are long.
    local ok = pcall(function()
      pcall(ffi.cdef, [[
        typedef struct { long tv_sec; long tv_nsec; } frameline_timespec_v1;
        int frameline_clock_gettime_v1(int, frameline_timespec_v1 *) __asm__("clock_gettime");
        int frameline_clock_getres_v1(int, frameline_timespec_v1 *) __asm__("clock_getres");
      ]])
      local stamp = ffi.new('frameline_timespec_v1[1]')
      local resolution = ffi.new('frameline_timespec_v1[1]')
      assert(ffi.C.frameline_clock_getres_v1(6, resolution) == 0)
      local resolution_ns = tonumber(resolution[0].tv_sec) * 1000000000 + tonumber(resolution[0].tv_nsec)
      assert(finite(resolution_ns) and resolution_ns >= 1 and resolution_ns % 1 == 0)
      clock.read = function()
        if ffi.C.frameline_clock_gettime_v1(6, stamp) ~= 0 then return nil end
        local sec, nano = tonumber(stamp[0].tv_sec), tonumber(stamp[0].tv_nsec)
        if not finite(sec) or sec % 1 ~= 0 or not finite(nano) or nano % 1 ~= 0 or nano >= 1000000000 then return nil end
        return {sec = sec, nano = nano}
      end
      assert(clock.read() ~= nil)
      clock.description = {status = 'captured', id = 'posix-clock-monotonic', clockId = 6,
        binding = 'LuaJIT-FFI-clock_gettime', monotonic = true, reportedResolutionNs = resolution_ns}
    end)
    if not ok then clock.read = nil end
  end
  if not clock.read and type(os) == 'table' and type(os.time) == 'function' then
    local ok, sample = pcall(os.time)
    if ok and finite(sample) and sample % 1 == 0 then
      clock.read = function()
        local success, value = pcall(os.time)
        if success and finite(value) and value % 1 == 0 then return {sec = value, nano = 0} end
        return nil
      end
      clock.description = {status = 'captured-coarse', id = 'lua-os-time', monotonic = false, reportedResolutionNs = 1000000000}
    end
  end
  if clock.read then
    local previous, minimum = clock.read(), nil
    for index = 1, 128 do
      local current = clock.read()
      local delta = delta_ns(previous, current)
      if delta and delta > 0 and (minimum == nil or delta < minimum) then minimum = delta end
      previous = current
    end
    clock.description.observedMinimumStepNs = minimum
  end
  clock.cpu = function()
    if type(os) ~= 'table' or type(os.clock) ~= 'function' then return nil end
    local ok, value = pcall(os.clock)
    if ok and finite(value) then return value end
    return nil
  end
  clock.measure = function(action)
    local wall_before = clock.read and clock.read() or nil
    local cpu_before = clock.cpu()
    local values
    local ok, err = pcall(function()
      local function pack(...) return {n = select('#', ...), ...} end
      values = pack(action())
    end)
    local cpu_after = clock.cpu()
    local wall_after = clock.read and clock.read() or nil
    local elapsed_ns = delta_ns(wall_before, wall_after)
    local measurement = {wallStatus = elapsed_ns and 'captured' or 'unavailable-or-regressed', wallNs = elapsed_ns,
      cpuStatus = 'unavailable', returnedNormally = ok}
    if cpu_before and cpu_after and cpu_after >= cpu_before then
      local micros = math.floor((cpu_after - cpu_before) * 1000000 + 0.5)
      if finite(micros) and micros <= 9007199254740991 then measurement.cpuStatus = 'captured'; measurement.cpuMicros = micros end
    end
    return ok, values, err, measurement
  end
  return clock
end
return {open = open_clock, delta_ns = delta_ns}
