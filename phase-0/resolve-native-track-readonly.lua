-- Read-only calibration-bound capture/export/capture/export/capture.
-- No SaveProject, project reopen, setters, imports, or challenge-name writes.
local expected_name = __EXPECTED_NAME__
local expected_project_id = __EXPECTED_PROJECT_ID__
local expected_observation = __EXPECTED_OBSERVATION__
local probe_id = __PROBE_ID__
local result_path = __RESULT_PATH__
local marker_path = __MARKER_PATH__
local first_export = __FIRST_EXPORT__
local second_export = __SECOND_EXPORT__
local base = (function()
__BASE_SOURCE__
end)()
local effects = (function()
__EFFECT_SOURCE__
end)()
local config = __PROPERTY_CONFIG__
local manager, fusion, stage = nil, nil, 'initial'
local before, between, after, page_before, page_after = nil, nil, nil, nil, nil
local events = base.array()
local function current()
  local project = assert(manager:GetCurrentProject(), 'Project unavailable')
  assert(resolve:GetVersionString() == '21.1.2.10' and project:GetName() == expected_name
    and project:GetUniqueId() == expected_project_id, 'Wrong source')
  return project
end
local function absent(filename)
  local reader = fusion:OpenFile(filename,1)
  if reader ~= nil then reader:Close();error('Output exists') end
end
local function write_exact(filename,value)
  absent(filename)
  local file=assert(fusion:OpenFile(filename,2),'Writer unavailable')
  local ok=pcall(function()assert(file:WriteLine(value)==#value+1,'Write failed');assert(file:Flush()==true,'Flush failed')end)
  local closed=pcall(function()file:Close()end);assert(ok and closed,'Write failed')
  local reader=assert(fusion:OpenFile(filename,1),'Reader unavailable');local expected=value..'\n'
  local checked,actual=pcall(function()
    assert(reader:GetFileSize()==#expected,'Size mismatch');local chunks,count={},0
    while count<#expected do local part=reader:ReadLine();assert(type(part)=='string'and#part>0 and#part<=#expected-count,'Read mismatch');chunks[#chunks+1]=part;count=count+#part end
    assert(reader:ReadLine()==nil and reader:GetFileSize()==#expected,'EOF mismatch');return table.concat(chunks)
  end)
  local read_closed=pcall(function()reader:Close()end);assert(checked and read_closed and actual==expected,'Readback mismatch')
end
local function capture(label)
  stage=label;current();local value=effects.capture(resolve,base,config)
  assert(effects.encode(value)==expected_observation,'Source state differs');current();events[#events+1]=label;return value
end
local function export(filename,label)
  stage=label;current();absent(filename)
  assert(manager:ExportProject(expected_name,filename,true)==true,'Export failed');current()
  local file=assert(fusion:OpenFile(filename,1),'Export unavailable');local size=file:GetFileSize();file:Close()
  assert(type(size)=='number'and size>0,'Empty export');events[#events+1]=label
end
local ok=pcall(function()
  manager=assert(resolve:GetProjectManager(),'Manager unavailable');current();fusion=assert(resolve:Fusion(),'Fusion unavailable')
  for _,filename in ipairs({result_path,marker_path,first_export,second_export})do absent(filename)end
  page_before=resolve:GetCurrentPage();assert(type(page_before)=='string','Page unavailable')
  before=capture('capture-before');export(first_export,'export-first');between=capture('capture-between')
  export(second_export,'export-second');after=capture('capture-after')
  page_after=resolve:GetCurrentPage();assert(page_after==page_before,'Page changed');stage='complete'
end)
if fusion~=nil then pcall(function()
  local result={schemaVersion=1,operation='resolve-native-track-readonly-capture',probeId=probe_id,status=ok and'captured'or'refused',stage=stage,
    readOnly=true,safeToApply=false,ordinaryApplySupported=false,events=events,before=before or{},between=between or{},after=after or{},
    pageBefore=page_before or{},pageAfter=page_after or{}}
  write_exact(result_path,effects.encode(result));write_exact(marker_path,'FRAMELINE_TRACK_READONLY_COMPLETE_V1:'..probe_id)
end)end
