-- Disposable-project experiment only. This is not a production relink adapter.
local function run(resolve, capture, encode, config)
  assert(resolve:GetVersionString() == '21.1.2.10', 'Resolve version changed')
  local pm = resolve:GetProjectManager()
  local project = assert(pm:GetCurrentProject(), 'Open the proof project')
  assert(project:GetName() == 'Frameline Relink Identity Proof'
    and project:GetUniqueId() == config.projectId, 'Unexpected proof project')
  assert(encode(capture()) == config.expectedObservation, 'Observed source changed')
  local expected, count = {}, 0
  for _, asset in ipairs(config.media) do
    assert(not expected[asset.mediaPoolId], 'Duplicate media ID')
    expected[asset.mediaPoolId] = asset.name
    count = count + 1
  end
  assert(count > 0, 'No media selected')
  local function selected(folder)
    local result, seen = {}, {}
    for _, media in ipairs(pm:GetCurrentProject():GetMediaPool():GetRootFolder():GetClipList() or {}) do
      local name = expected[media:GetUniqueId()]
      if name then
        assert(not seen[media:GetUniqueId()], 'Duplicate media ID returned')
        seen[media:GetUniqueId()] = true
        assert(media:GetClipProperty('File Path') == folder .. '/' .. name, 'Media location changed')
        result[#result + 1] = media
      end
    end
    assert(#result == count, 'Media ID missing')
    return result
  end
  local media = selected(config.sourceDirectory)
  assert(bmd and type(bmd.fileexists) == 'function', 'Filesystem check unavailable')
  for _, asset in ipairs(config.media) do
    assert(bmd.fileexists(config.targetDirectory .. '/' .. asset.name), 'Target media missing')
  end
  assert(project:GetMediaPool():RelinkClips(media, config.targetDirectory), 'Relink failed')
  selected(config.targetDirectory)
  assert(pm:SaveProject(), 'Save failed')
  assert(pm:CloseProject(project), 'Close failed')
  assert(pm:LoadProject('Frameline Relink Identity Proof'), 'Reopen failed')
  assert(pm:GetCurrentProject():GetUniqueId() == config.projectId, 'Reopened project ID changed')
  local reopenedMedia = selected(config.targetDirectory)
  local observation = capture()
  assert(encode(observation) == config.expectedObservation, 'Reopened observation differs')
  local paths = setmetatable({}, {__array = true})
  for _, item in ipairs(reopenedMedia) do
    paths[#paths + 1] = {mediaPoolId = item:GetUniqueId(), name = expected[item:GetUniqueId()], pathMatches = true}
  end
  return {schemaVersion = 1, operation = 'resolve-relink-identity-result', projectId = config.projectId,
    experimental = true, safeToApply = false, savedAndReopened = true, media = paths, observation = observation}
end
return {run = run}
