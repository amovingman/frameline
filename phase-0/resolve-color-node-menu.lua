-- Opt-in first-layer color node-slot reads. No project mutations or selection.
local project_name=__PROJECT_NAME__
local project_id=__PROJECT_ID__
local request_id=__REQUEST_ID__
local result_path=__RESULT_PATH__
local observation_path=__OBSERVATION_PATH__
local marker_path=__MARKER_PATH__
local failure_path=__FAILURE_PATH__
local stage='guard'
local fusion,encode,write_exact,guarded
local ok,err=pcall(function()
  assert(resolve and resolve:GetVersionString()=='21.1.2.10','Unexpected version')
  local project=assert(resolve:GetProjectManager():GetCurrentProject(),'No project')
  assert(project:GetName()==project_name and project:GetUniqueId()==project_id,'Wrong disposable project')
  assert(resolve:GetCurrentPage()=='color','Open Color page before capture')
  guarded=true
  fusion=assert(resolve:Fusion(),'No Fusion file runtime')
  local function absent(filename)local h=fusion:OpenFile(filename,1);if h then h:Close();error('Output already exists')end end
  for _,filename in ipairs({result_path,observation_path,marker_path,failure_path})do absent(filename)end
  write_exact=function(filename,value)
    absent(filename);assert(#value<2*1024*1024,'Output exceeds bound')
    local handle=assert(fusion:OpenFile(filename,2),'Writer unavailable')
    local written=pcall(function()assert(handle:WriteLine(value)==#value+1,'Write failed');assert(handle:Flush()==true,'Flush failed')end)
    local closed=pcall(function()handle:Close()end);assert(written and closed,'Write failed')
    local reader=assert(fusion:OpenFile(filename,1),'Readback unavailable')
    local good,actual=pcall(function()
      assert(reader:GetFileSize()==#value+1,'Readback size changed');local parts,count={},0
      while count<#value+1 do local part=reader:ReadLine();assert(type(part)=='string' and #part>0 and #part<=#value+1-count,'Readback failed');parts[#parts+1]=part;count=count+#part end
      assert(reader:ReadLine()==nil,'Readback grew');return table.concat(parts)
    end)
    local shut=pcall(function()reader:Close()end);assert(good and shut and actual==value..'\n','Readback differs')
  end
  local base=(function()
__BASE_SOURCE__
  end)()
  local effects=(function()
__EFFECT_SOURCE__
  end)()
  local nodes=(function()
__NODE_SOURCE__
  end)()
  encode=effects.encode
  local expected=__EXPECTED_RICH_JSON__
  local function rich()return effects.capture(resolve,base,__PROPERTY_CONFIG__)end
  stage='capture'
  assert(encode(rich())==expected,'Rich baseline changed')
  local observation=nodes.capture(resolve,base,encode,50,2048)
  assert(encode(rich())==expected,'Rich baseline changed')
  assert(observation.snapshot.project_id==project_id and #observation.items==50,'Fixture context changed')
  local bytes=encode(observation)
  stage='observation-write';write_exact(observation_path,bytes)
  stage='result-write';write_exact(result_path,encode({schemaVersion=1,operation='resolve-color-node-menu',requestId=request_id,
    readOnly=true,safeToApply=false,projectId=project_id,itemCount=#observation.items,observationBytes=#bytes}))
  stage='marker-write';write_exact(marker_path,'FRAMELINE_COLOR_NODE_COMPLETE_V1:'..request_id)
  print('FRAMELINE_COLOR_NODE_OK_V1:'..request_id)
end)
if not ok then
  local code='capture-failed'
  if stage~='guard' and stage~='capture' then code='output-failed'
  elseif type(err)=='string' and err:find('exceeds bound',1,true) then code='oversize'
  elseif type(err)=='string' and err:find('changed',1,true) then code='state-changed'
  elseif type(err)=='string' and err:find('Invalid color-node',1,true) then code='invalid-value' end
  if guarded and encode and write_exact then pcall(function()write_exact(failure_path,encode({schemaVersion=1,operation='resolve-color-node-menu-failure',
    requestId=request_id,readOnly=true,safeToApply=false,stage=stage,errorCode=code}))end)end
  print('FRAMELINE_COLOR_NODE_FAILED_V1:'..request_id)
end
