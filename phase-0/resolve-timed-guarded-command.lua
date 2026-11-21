-- Instrumentation around an unchanged command from the existing guarded trial.
-- It is experimental and does not confer editor-write permission.
local expected_name = __EXPECTED_NAME__
local expected_id = __EXPECTED_ID__
local transaction_id = __TRANSACTION_ID__
local probe_id = __PROBE_ID__
local stage_label = __STAGE_LABEL__
local command_sha = __COMMAND_SHA__
local result_path = __RESULT_PATH__
local complete_path = __COMPLETE_PATH__
local started_prefix = __STARTED_PREFIX__
local real_resolve = resolve
local outer_ok = pcall(function()
  assert(real_resolve and real_resolve:GetVersionString() == '21.1.2.10', 'Unexpected version')
  local initial = real_resolve:GetProjectManager():GetCurrentProject()
  assert(initial and initial:GetName() == expected_name and initial:GetUniqueId() == expected_id, 'Unexpected disposable project')
  local count = 0
  for index = 1, initial:GetTimelineCount() do
    local timeline = initial:GetTimelineByIndex(index)
    for _, kind in ipairs({'video','audio','subtitle'}) do
      for track = 1, timeline:GetTrackCount(kind) do count = count + #(timeline:GetItemListInTrack(kind,track) or {}) end
    end
  end
  assert(count >= 1 and count <= 50, 'Small fixture required')
  local encode_module = (function()
__BASE_ENCODER__
  end)()
  local clock_module = (function()
__CLOCK_SOURCE__
  end)()
  local timer = clock_module.open()
  local fusion = assert(real_resolve:Fusion())
  local function absent(filename)
    local previous = fusion:OpenFile(filename,1)
    if previous then previous:Close();error('Timing output already exists') end
  end
  local function write(filename,value)
    absent(filename)
    local writer=assert(fusion:OpenFile(filename,2))
    local good=pcall(function()assert(writer:WriteLine(value)==#value+1);assert(writer:Flush()==true)end)
    local closed=pcall(function()writer:Close()end)
    assert(good and closed,'Timing write failed')
    local reader=assert(fusion:OpenFile(filename,1));local expected=value..'\n'
    local read_ok,actual=pcall(function()
      assert(reader:GetFileSize()==#expected)
      local parts,n={},0
      while n<#expected do local part=reader:ReadLine();assert(type(part)=='string'and #part>0 and #part<=#expected-n);n=n+#part;parts[#parts+1]=part end
      assert(reader:ReadLine()==nil);return table.concat(parts)
    end)
    local shut=pcall(function()reader:Close()end)
    assert(read_ok and shut and actual==expected,'Timing readback failed')
  end
  absent(result_path);absent(complete_path)
  write(started_prefix..'session.json',encode_module.encode({schemaVersion=1,probeId=probe_id,transactionId=transaction_id,commandSha256=command_sha}))
  local calls=encode_module.array()
  local function timed(method,action)
    local index=#calls+1;assert(index<=128,'Timing call limit')
    write(started_prefix..index..'.json',encode_module.encode({schemaVersion=1,probeId=probe_id,transactionId=transaction_id,index=index,method=method}))
    local ok,values,err,measurement=timer.measure(action)
    measurement.index=index;measurement.method=method
    if ok then measurement.returnCount=values.n;measurement.firstReturnType=type(values[1]);if type(values[1])=='boolean'then measurement.firstReturnBoolean=values[1]end end
    calls[#calls+1]=measurement
    if not ok then error(err,0)end
    return unpack(values,1,values.n)
  end
  local native_by_proxy=setmetatable({},{__mode='k'})
  local function proxy(native,overrides)
    if native==nil then return nil end
    local object={};native_by_proxy[object]=native
    return setmetatable(object,{__index=function(_,name)
      if overrides[name]then return overrides[name]end
      local value=native[name]
      if type(value)=='function'then return function(_,...)
        local arguments={n=select('#',...),...}
        for index=1,arguments.n do arguments[index]=native_by_proxy[arguments[index]]or arguments[index]end
        return value(native,unpack(arguments,1,arguments.n))
      end end
      return value
    end})
  end
  local wrap_project,wrap_timeline,wrap_item
  wrap_item=function(native)return proxy(native,{SetName=function(_,name)return timed('item.SetName',function()return native:SetName(name)end)end})end
  wrap_timeline=function(native)return proxy(native,{GetItemListInTrack=function(_,kind,index)
    local raw=native:GetItemListInTrack(kind,index);if raw==nil then return nil end
    local list={};for key,value in pairs(raw)do if type(key)=='number'then list[key]=wrap_item(value)else list[key]=value end end;return list
  end})end
  wrap_project=function(native)return proxy(native,{
    GetTimelineByIndex=function(_,index)return wrap_timeline(native:GetTimelineByIndex(index))end,
    GetCurrentTimeline=function()return wrap_timeline(native:GetCurrentTimeline())end})end
  local manager=real_resolve:GetProjectManager()
  local manager_proxy=proxy(manager,{
    GetCurrentProject=function()return wrap_project(manager:GetCurrentProject())end,
    SaveProject=function()return timed('manager.SaveProject',function()return manager:SaveProject()end)end,
    ExportProject=function(_,...)local args={n=select('#',...),...};return timed('manager.ExportProject',function()return manager:ExportProject(unpack(args,1,args.n))end)end,
    CloseProject=function(_,project)return timed('manager.CloseProject',function()return manager:CloseProject(native_by_proxy[project]or project)end)end,
    LoadProject=function(_,name)local project=timed('manager.LoadProject',function()return manager:LoadProject(name)end);return wrap_project(project)end})
  local resolve=proxy(real_resolve,{GetProjectManager=function()return manager_proxy end})
  local command_ok,values,command_error,total=timer.measure(function()
__EMITTED_COMMAND__
  end)
  local report={schemaVersion=1,operation='resolve-timed-guarded-command',probeId=probe_id,transactionId=transaction_id,
    stage=stage_label,experimental=true,safeToApply=false,commandSha256=command_sha,projectId=expected_id,projectName=expected_name,
    representedItemCount=count,wallClock=timer.description,total=total,calls=calls,commandReturnedNormally=command_ok,
    failureCode=command_ok and 'none'or 'guarded-command-failed'}
  local payload=encode_module.encode(report);assert(#payload<=1024*1024,'Timing report too large')
  write(result_path,payload);write(complete_path,'FRAMELINE_TIMED_COMMAND_COMPLETE_V1:'..probe_id)
  print('FRAMELINE_TIMED_COMMAND_OK_V1:'..probe_id)
end)
if not outer_ok then print('FRAMELINE_TIMED_COMMAND_FAILED_V1:'..probe_id)end
