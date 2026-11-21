-- Controlled changes to known empty tracks in one backed-up synthetic fixture.
local expected_name = __EXPECTED_NAME__
local expected_project_id = __EXPECTED_PROJECT_ID__
local expected_before = __EXPECTED_BEFORE__
local expected_after = __EXPECTED_AFTER__
local backup_path = __BACKUP_PATH__
local backup_size = __BACKUP_SIZE__
local export_before = __EXPORT_BEFORE__
local export_after = __EXPORT_AFTER__
local result_path = __RESULT_PATH__
local marker_path = __MARKER_PATH__
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
  local value = assert(manager:GetCurrentProject(), 'Project unavailable')
  assert(resolve:GetVersionString() == '21.1.2.10' and value:GetName() == expected_name
    and value:GetUniqueId() == expected_project_id, 'Wrong disposable project')
  return value
end
local function capture()current();return effects.capture(resolve,base,config)end
local function absent(filename)
  local reader=fusion:OpenFile(filename,1)
  if reader~=nil then reader:Close();error('Output exists')end
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
local function export(filename)
  absent(filename);assert(manager:ExportProject(expected_name,filename,true)==true,'Export failed')
  local file=assert(fusion:OpenFile(filename,1),'Export unavailable');local size=file:GetFileSize();file:Close();assert(type(size)=='number'and size>0,'Empty export')
end
local function empty(timeline,index)
  local list=timeline:GetItemListInTrack('video',index)
  assert(list==nil or type(list)=='table','Track read unavailable')
  for key in pairs(list or {})do assert(key=='__flags','Target track is not empty')end
end
local before,after=nil,nil
local ok=pcall(function()
  manager=assert(resolve:GetProjectManager(),'Manager unavailable');current();fusion=assert(resolve:Fusion(),'Fusion unavailable')
  for _,filename in ipairs(__ALL_OUTPUTS__)do absent(filename)end
  local backup=assert(fusion:OpenFile(backup_path,1),'Backup unavailable');local size=backup:GetFileSize();backup:Close();assert(size==backup_size,'Backup differs')
  stage='source-check';before=capture();assert(effects.encode(before)==expected_before,'Source differs')
  stage='before-export';export(export_before)
  local project=current();assert(project:GetTimelineCount()==1,'Unexpected timeline count');local timeline=project:GetTimelineByIndex(1)
  assert(timeline:GetUniqueId()==__TIMELINE_ID__,'Wrong timeline')
  stage='empty-track-mutation';mutated=true
__MUTATION_SOURCE__
  stage='save-reopen';assert(manager:SaveProject()==true,'Save failed');assert(manager:CloseProject(current())==true,'Close failed')
  assert(manager:LoadProject(expected_name)~=nil,'Reopen failed');current()
  after=capture();assert(effects.encode(after)==expected_after,'Topology state differs')
  stage='after-export';export(export_after);stage='topology-complete'
end)
local status=ok and 'ready-for-challenge'or(mutated and'recovery-required'or'refused')
if fusion~=nil then
  pcall(function()
    local value={schemaVersion=1,operation='resolve-native-track-topology',probeId=probe_id,status=status,stage=stage,
      safeToApply=false,ordinaryApplySupported=false,before=before or{},after=after or{}}
    write_exact(result_path,effects.encode(value));write_exact(marker_path,'FRAMELINE_TRACK_TOPOLOGY_COMPLETE_V1:'..probe_id)
  end)
end
if ok then
  local file=assert(fusion:OpenFile(export_after,1),'Post-operation backup unavailable')
  local topology_backup_bytes=file:GetFileSize();file:Close();assert(topology_backup_bytes>0,'Post-operation backup empty')
  do
__CHALLENGE_SOURCE__
  end
end
