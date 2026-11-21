-- Independent current-location witnesses, not persistent track IDs.
local NULL={}
local function integer(value,max)return type(value)=='number'and value==value and value>=1 and value%1==0 and value<=max end
local function kind(value)return value=='video'or value=='audio'or value=='subtitle'end
local function list_size(value)
  if type(value)~='table'then error('Invalid API-location list')end
  local n=0;for key in pairs(value)do if type(key)=='number'and key>=1 and key%1==0 then n=n+1 elseif key~='__flags'then error('Invalid API-location list')end end
  if n~=#value then error('Sparse API-location list')end;return n
end
local function read_location(item)
  local ok,value=pcall(function()return item:GetTrackTypeAndIndex()end)
  if not ok or value==nil or value==false then return{status='unavailable',value=NULL}end
  if list_size(value)~=2 or not kind(value[1])or not integer(value[2],200)then error('Invalid API-location type/index')end
  return{status='captured',value={type=value[1],index=value[2]}}
end
local function read_position(item)
  -- False preserves the SDK's frame-aligned GetPosition mode. No subframe proof.
  local ok,value=pcall(function()return item:GetPosition(false)end)
  if not ok or value==nil or value==false then return{status='unavailable',value=NULL}end
  if type(value)~='table'then error('Invalid API-location position')end
  local result=setmetatable({},{__object=true})
  for key,entry in pairs(value)do
    if key=='trackType'then if not kind(entry)then error('Invalid API-location position kind')end;result.trackType=entry
    elseif key=='trackIndex'then if not integer(entry,200)then error('Invalid API-location position index')end;result.trackIndex=entry
    elseif key=='startFrame'then
      if type(entry)~='number'or entry~=entry or math.abs(entry)>9007199254740991 then error('Invalid API-location position frame')end
      result.startFrame={decimal=string.format('%.16e',entry)}
    elseif key~='__flags'then error('Undocumented API-location position field')end
  end
  return{status='captured',value=result}
end
local function active_id(project)local t=project:GetCurrentTimeline();return t and t:GetUniqueId()or NULL end
local function page_name(resolve)
  local ok,value=pcall(function()return resolve:GetCurrentPage()end)
  if not ok or value==nil then return NULL end
  if value~='media'and value~='photo'and value~='cut'and value~='edit'and value~='fusion'and value~='color'and value~='fairlight'and value~='deliver'then error('Invalid API-location page')end
  return value
end
local function runtime(resolve)
  local function observed(action,kind)
    local ok,value=pcall(action)
    if not ok or value==nil or(kind=='text'and value==false)then return{status='unavailable',value=NULL}end
    if kind=='boolean'then if type(value)~='boolean'then error('Invalid API-location runtime boolean')end
    elseif type(value)~='string'or #value<1 or #value>80 or value:find('[%z\1-\31\127/\\]')then error('Invalid API-location runtime text')end
    return{status='captured',value=value}
  end
  return{version=observed(function()return resolve:GetVersionString()end,'text'),productName=observed(function()return resolve:GetProductName()end,'text'),isStudio=observed(function()return resolve:IsStudio()end,'boolean')}
end
local function read_once(resolve,base)
  local project=resolve:GetProjectManager():GetCurrentProject();local records=base.array()
  for ti=1,project:GetTimelineCount()do local timeline=project:GetTimelineByIndex(ti)
    for _,track_type in ipairs({'video','audio','subtitle'})do for index=1,timeline:GetTrackCount(track_type)do
      local list=timeline:GetItemListInTrack(track_type,index)or{};list_size(list)
      for _,item in ipairs(list)do records[#records+1]={timelineId=timeline:GetUniqueId(),itemId=item:GetUniqueId(),enumeratedLocation={type=track_type,index=index},trackTypeAndIndex=read_location(item),position=read_position(item)}end
    end end
  end
  table.sort(records,function(a,b)if a.timelineId~=b.timelineId then return a.timelineId<b.timelineId end;return a.itemId<b.itemId end)
  return records
end
local function capture(resolve,base,effects,property_config,max_items)
  if not integer(max_items,200)then error('Invalid API-location item bound')end
  local project=assert(resolve:GetProjectManager():GetCurrentProject(),'Open a project')
  local timelines=project:GetTimelineCount();if type(timelines)~='number'or timelines%1~=0 or timelines<0 or timelines>20 then error('API-location timeline bound exceeded')end
  local count,tracks=0,0
  for ti=1,timelines do local timeline=project:GetTimelineByIndex(ti)
    for _,track_type in ipairs({'video','audio','subtitle'})do local n=timeline:GetTrackCount(track_type)
      if type(n)~='number'or n%1~=0 or n<0 or tracks+n>200 then error('API-location track bound exceeded')end;tracks=tracks+n
      for index=1,n do count=count+list_size(timeline:GetItemListInTrack(track_type,index)or{});if count>max_items then error('API-location project exceeds bound')end end
    end
  end
  local encode=effects.encode;local page=page_name(resolve);local build=runtime(resolve);local rich=effects.capture(resolve,base,property_config);local active=active_id(project)
  local items=read_once(resolve,base)
  assert(encode(items)==encode(read_once(resolve,base)),'API-location witnesses changed during capture')
  assert(encode(rich)==encode(effects.capture(resolve,base,property_config)),'API-location rich context changed')
  assert(encode(page)==encode(page_name(resolve)),'API-location page context changed')
  assert(encode(active)==encode(active_id(project)),'API-location active timeline changed')
  assert(encode(build)==encode(runtime(resolve)),'API-location runtime context changed')
  assert(#items==count,'API-location membership changed')
  return{schemaVersion=1,operation='resolve-api-location-observation',readOnly=true,safeToApply=false,richContext=rich,activeTimelineId=active,capturePage=page,runtime=build,items=items,
    capturePasses=2,representedContextUnchangedAcrossReads=true,positionSubframePrecision=false,identityScope='namespace-item-uuid-with-current-api-location',persistentTrackIdsObserved=false}
end
return{capture=capture}
