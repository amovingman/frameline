-- Separately authorized disposable cosmetic annotation drill, not a grade edit.
local project_name=__PROJECT_NAME__
local project_id=__PROJECT_ID__
local request_id=__REQUEST_ID__
local paths=__PATHS__
local stage='guard'
local mutation_attempted=false
local fusion,encode,write_exact,guarded
local ok,err=pcall(function()
  assert(resolve and resolve:GetVersionString()=='21.1.2.10','Unexpected version')
  local pm=resolve:GetProjectManager()
  local project=assert(pm:GetCurrentProject(),'No project')
  assert(project:GetName()==project_name and project:GetUniqueId()==project_id,'Wrong disposable project')
  assert(resolve:GetCurrentPage()=='color','Open Color page before drill')
  guarded=true
  fusion=assert(resolve:Fusion(),'No Fusion file runtime')
  local function absent(filename)local h=fusion:OpenFile(filename,1);if h then h:Close();error('Output already exists')end end
  for _,filename in ipairs({paths.result,paths.richResult,paths.extraResult,paths.nodesResult,paths.marker,paths.failure,paths.started,paths.afterBackup})do absent(filename)end
  local function read_exact(filename,value)
    local h=assert(fusion:OpenFile(filename,1),'Proof input unavailable')
    local good,actual=pcall(function()
      assert(h:GetFileSize()==#value,'Proof input size changed');local parts,n={},0
      while n<#value do local s=h:ReadLine();assert(type(s)=='string' and #s>0 and #s<=#value-n,'Proof input read failed');parts[#parts+1]=s;n=n+#s end
      assert(h:ReadLine()==nil,'Proof input grew');return table.concat(parts)
    end)
    local shut=pcall(function()h:Close()end);assert(good and shut and actual==value,'Proof input changed')
  end
  write_exact=function(filename,value)
    absent(filename);assert(#value<2*1024*1024,'Output exceeds bound')
    local h=assert(fusion:OpenFile(filename,2),'Writer unavailable')
    local good=pcall(function()assert(h:WriteLine(value)==#value+1,'Write failed');assert(h:Flush()==true,'Flush failed')end)
    local shut=pcall(function()h:Close()end);assert(good and shut,'Write failed');read_exact(filename,value..'\n')
  end
  local base=(function()
__BASE_SOURCE__
  end)()
  local effects=(function()
__EFFECT_SOURCE__
  end)()
  local state=(function()
__STATE_SOURCE__
  end)()
  local nodes=(function()
__NODE_SOURCE__
  end)()
  encode=effects.encode
  local expected_rich=__RICH_JSON__
  local expected_extra=__EXTRA_JSON__
  local expected_source_nodes=__SOURCE_NODES_JSON__
  local expected_result_nodes=__RESULT_NODES_JSON__
  local function rich()return effects.capture(resolve,base,__PROPERTY_CONFIG__)end
  local function inspect(expected_nodes)
    local r=rich();assert(encode(r)==expected_rich,'Rich state changed')
    local e=state.capture(resolve,base,encode,50);assert(encode(e)==expected_extra,'Seven-field state changed')
    local n=nodes.capture(resolve,base,encode,50,2048);assert(encode(n)==expected_nodes,'Node-slot state changed')
    assert(encode(rich())==expected_rich,'Rich state changed')
    return r,e,n
  end
  local function target_graph()
    local p=assert(pm:GetCurrentProject(),'No project')
    assert(p:GetName()==project_name and p:GetUniqueId()==project_id,'Wrong disposable project')
    for ti=1,p:GetTimelineCount()do
      local timeline=p:GetTimelineByIndex(ti)
      if timeline:GetUniqueId()==__TIMELINE_ID__ then
        for _,kind in ipairs({'video','audio','subtitle'})do
          for track=1,timeline:GetTrackCount(kind)do
            for _,item in ipairs(timeline:GetItemListInTrack(kind,track)or{})do
              if item:GetUniqueId()==__TARGET_ID__ then
                assert(item:GetName()==__TARGET_NAME__,'Target name changed')
                local graph=assert(item:GetNodeGraph(),'Target graph unavailable')
                assert(graph:GetNumNodes()==1,'Target one-node scope changed')
                assert(graph:GetNodeColor(1)==__SOURCE_COLOR__,'Target color changed')
                assert(graph:GetNodeCacheMode(1)==__SOURCE_CACHE__,'Target cache changed')
                return graph
              end
            end
          end
        end
      end
    end
    error('Target item missing')
  end
  stage='capture';read_exact(paths.ready,__READY_BYTES__);inspect(expected_source_nodes);target_graph()
  do local h=assert(fusion:OpenFile(paths.backup,1),'Verified backup missing');local same=h:GetFileSize()==__BACKUP_SIZE__;h:Close();assert(same,'Verified backup size changed')end
  write_exact(paths.started,__STARTED_BYTES__)
  stage='pre-write-recheck';inspect(expected_source_nodes)
  local graph=target_graph()
  stage='color-write';mutation_attempted=true
  assert(graph:SetNodeColor(1,__RESULT_COLOR__),'Node color write failed')
  stage='post-write-validation';inspect(expected_result_nodes)
  stage='save';assert(pm:SaveProject(),'Save failed')
  stage='post-save-validation';inspect(expected_result_nodes)
  stage='close-reopen';assert(pm:CloseProject(pm:GetCurrentProject()),'Close failed');assert(pm:LoadProject(project_name),'Load failed')
  assert(pm:GetCurrentProject():GetUniqueId()==project_id,'Reopened project changed')
  stage='validation';inspect(expected_result_nodes)
  stage='post-state-export';assert(pm:ExportProject(project_name,paths.afterBackup,false),'Post-state export failed')
  local r,e,n=inspect(expected_result_nodes)
  stage='result-write';write_exact(paths.richResult,encode(r));write_exact(paths.extraResult,encode(e));write_exact(paths.nodesResult,encode(n))
  write_exact(paths.result,encode({schemaVersion=1,operation='resolve-color-node-challenge',requestId=request_id,mode=__MODE__,
    experimental=true,readOnly=false,safeToApply=false,projectId=project_id,targetItemId=__TARGET_ID__,nodeIndex=1,color=__RESULT_COLOR__,itemCount=50}))
  stage='marker-write';write_exact(paths.marker,'FRAMELINE_COLOR_NODE_CHALLENGE_COMPLETE_V1:'..request_id)
  print('FRAMELINE_COLOR_NODE_CHALLENGE_OK_V1:'..request_id)
end)
if not ok then
  local code='operation-failed'
  if stage=='guard' or stage=='capture' then code='preflight-failed' elseif stage=='result-write' or stage=='marker-write' then code='output-failed' end
  if guarded and encode and write_exact then pcall(function()write_exact(paths.failure,encode({schemaVersion=1,operation='resolve-color-node-challenge-failure',
    requestId=request_id,readOnly=false,experimental=true,safeToApply=false,stage=stage,errorCode=code,mutationAttempted=mutation_attempted}))end)end
  print('FRAMELINE_COLOR_NODE_CHALLENGE_FAILED_V1:'..request_id)
end
