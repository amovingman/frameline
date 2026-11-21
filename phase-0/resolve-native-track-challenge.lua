-- Disposable track-name challenge; restores names and verifies represented state.
-- Native bytes are export/backup artifacts only. Ordinary Apply is never enabled.
local expected_name = __EXPECTED_NAME__
local expected_project_id = __EXPECTED_PROJECT_ID__
local expected_before = __EXPECTED_BEFORE__
local expected_challenged = __EXPECTED_CHALLENGED__
local bindings = __BINDINGS__
local result_path = __RESULT_PATH__
local marker_path = __MARKER_PATH__
local backup_path = __BACKUP_PATH__
local backup_bytes = __BACKUP_BYTES__
local export_before = __EXPORT_BEFORE__
local export_challenged = __EXPORT_CHALLENGED__
local export_restored = __EXPORT_RESTORED__
local probe_id = __PROBE_ID__
local base = (function()
__BASE_SOURCE__
end)()
local effects = (function()
__EFFECT_SOURCE__
end)()
local config = __PROPERTY_CONFIG__
local manager, fusion, mutated, stage = nil, nil, false, 'initial'
local function current()
  local project = assert(manager:GetCurrentProject(), 'Project unavailable')
  assert(resolve:GetVersionString() == '21.1.2.10' and project:GetName() == expected_name
    and project:GetUniqueId() == expected_project_id, 'Wrong disposable project')
  return project
end
local function capture() current(); return effects.capture(resolve, base, config) end
local function timeline(project, id)
  local found = nil
  for index = 1, project:GetTimelineCount() do
    local value = project:GetTimelineByIndex(index)
    if value:GetUniqueId() == id then assert(found == nil, 'Duplicate timeline'); found = value end
  end
  return assert(found, 'Timeline unavailable')
end
local function absent(filename)
  local reader = fusion:OpenFile(filename, 1)
  if reader ~= nil then reader:Close(); error('Output already exists') end
end
local function write_exact(filename, value)
  absent(filename)
  local handle = assert(fusion:OpenFile(filename, 2), 'Writer unavailable')
  local ok = pcall(function() assert(handle:WriteLine(value) == #value + 1, 'Write failed'); assert(handle:Flush() == true, 'Flush failed') end)
  local closed = pcall(function() handle:Close() end)
  assert(ok and closed, 'Write failed')
  local reader = assert(fusion:OpenFile(filename, 1), 'Reader unavailable')
  local expected = value .. '\n'
  local checked, actual = pcall(function()
    assert(reader:GetFileSize() == #expected, 'Size mismatch')
    local chunks, count = {}, 0
    while count < #expected do
      local part = reader:ReadLine(); assert(type(part) == 'string' and #part > 0 and #part <= #expected - count, 'Read mismatch')
      chunks[#chunks + 1] = part; count = count + #part
    end
    assert(reader:ReadLine() == nil and reader:GetFileSize() == #expected, 'EOF mismatch')
    return table.concat(chunks)
  end)
  local read_closed = pcall(function() reader:Close() end)
  assert(checked and read_closed and actual == expected, 'Readback mismatch')
end
local function reopen()
  local project = current()
  assert(manager:CloseProject(project) == true, 'Close failed')
  assert(manager:LoadProject(expected_name) ~= nil, 'Reopen failed')
  return current()
end
local function export(filename)
  absent(filename)
  assert(manager:ExportProject(expected_name, filename, true) == true, 'Export failed')
  local file = assert(fusion:OpenFile(filename, 1), 'Export unavailable')
  local size = file:GetFileSize(); file:Close(); assert(type(size) == 'number' and size > 0, 'Empty export')
end
local function set_names(challenge)
  local project = current()
  for _, binding in ipairs(bindings) do
    local target = timeline(project, binding.timelineId)
    assert(target:SetTrackName(binding.type, binding.index, challenge and binding.challengeName or binding.originalName) == true, 'Track rename failed')
  end
end
local function can_restore(observed)
  for _, value in ipairs(observed.snapshot.timelines) do
    for _, track in ipairs(value.tracks) do
      local found = false
      for _, binding in ipairs(bindings) do
        if binding.timelineId == value.id and binding.type == track.type and binding.index == track.index then
          assert(track.name == binding.originalName or track.name == binding.challengeName, 'Unrelated track name changed')
          track.name = binding.originalName; found = true; break
        end
      end
      assert(found, 'Unexpected track')
    end
  end
  return effects.encode(observed) == expected_before
end
local before, challenged, reopened, restored = nil, nil, nil, nil
local ok = pcall(function()
  manager = assert(resolve:GetProjectManager(), 'Manager unavailable'); current()
  fusion = assert(resolve:Fusion(), 'Fusion unavailable')
  for _, filename in ipairs({result_path, marker_path, export_before, export_challenged, export_restored}) do absent(filename) end
  local backup = assert(fusion:OpenFile(backup_path, 1), 'Verified backup unavailable')
  local size = backup:GetFileSize(); backup:Close(); assert(size == backup_bytes, 'Backup size changed')
  stage = 'source-check'; before = capture(); assert(effects.encode(before) == expected_before, 'Source changed')
  stage = 'baseline-export'; export(export_before)
  stage = 'challenge'; mutated = true; set_names(true); assert(manager:SaveProject() == true, 'Save failed')
  challenged = capture(); assert(effects.encode(challenged) == expected_challenged, 'Challenge state differs')
  stage = 'challenge-reopen'; reopen(); reopened = capture(); assert(effects.encode(reopened) == expected_challenged, 'Challenge did not persist')
  export(export_challenged)
  stage = 'restore'; set_names(false); assert(manager:SaveProject() == true, 'Restore save failed')
  stage = 'restore-reopen'; reopen(); restored = capture(); assert(effects.encode(restored) == expected_before, 'Restored state differs')
  export(export_restored); stage = 'complete'
end)
local status = ok and 'restored' or (mutated and 'recovery-required' or 'refused')
if not ok and mutated then
  local recovered = pcall(function()
    assert(can_restore(capture()), 'Unrelated represented state changed')
    set_names(false); assert(manager:SaveProject() == true, 'Recovery save failed'); reopen()
    restored = capture(); assert(effects.encode(restored) == expected_before, 'Recovery state differs')
  end)
  if recovered then status = 'rolled-back' end
end
if fusion ~= nil then
  local published = pcall(function()
    local result = {schemaVersion = 1, operation = 'resolve-native-track-challenge', probeId = probe_id,
      safeToApply = false, status = status, stage = stage, ordinaryApplySupported = false,
      representedStateRestored = restored ~= nil and effects.encode(restored) == expected_before,
      before = before or {}, challenged = challenged or {}, reopened = reopened or {}, restored = restored or {}}
    local payload = effects.encode(result); assert(#payload <= 20 * 1024 * 1024, 'Result too large')
    write_exact(result_path, payload); write_exact(marker_path, 'FRAMELINE_NATIVE_TRACK_CHALLENGE_COMPLETE_V1:' .. probe_id)
  end)
  if published then print('FRAMELINE_NATIVE_TRACK_CHALLENGE_RECORDED_V1:' .. probe_id) end
end
