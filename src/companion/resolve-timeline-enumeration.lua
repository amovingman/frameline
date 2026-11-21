-- Strict outer-timeline enumeration. No missing collection becomes an empty list.
-- Slot indexes/catalogue IDs enumerate applied effects, not persistent instances.
local NULL={}
local kinds={'video','audio','subtitle'}
local categories={'fusion','ofx','audio'}
local function unavailable()return{status='unavailable',value=NULL}end
local function captured(value)return{status='captured',value=value}end
local function integer(v,max)return type(v)=='number'and v==v and v>=0 and v%1==0 and v<=max end
local function text(v,token,catalogue)
  if type(v)~='string'or #v<1 or #v>2048 or v:find('[%z\1-\31\127\\]')then error('Invalid enumeration text')end
  if token and not v:match('^[A-Za-z0-9_.%-]+$')then error('Invalid enumeration token')end
  if catalogue then
    if v:find('://',1,true)or v:sub(1,1)=='/'or v:match('^[A-Za-z]:')or v:find('/%.%./')or v:sub(-3)=='/..'then error('Invalid enumeration catalogue id')end
    if v:find('/',1,true)and v:sub(1,11)~='Resolve FX/'and v:sub(1,7)~='Fusion/'and v:sub(1,9)~='Audio FX/'then error('Invalid enumeration catalogue id')end
  elseif v:find('/',1,true)or v:match('^[A-Za-z]:')then error('Invalid enumeration text')end
  return v
end
local function dense(list,max)
  if type(list)~='table'then error('Invalid enumeration list')end
  local count,maximum=0,0
  for key in pairs(list)do if type(key)=='number'and key>=1 and key%1==0 then count=count+1;maximum=math.max(maximum,key) elseif key~='__flags'then error('Unknown enumeration list key')end end
  if count~=#list or maximum~=count or count>max then error('Sparse or oversized enumeration list')end
  return count
end
local function observe(action,kind)
  local ok,value=pcall(action)
  if not ok or value==nil or(value==false and kind~='boolean')then return unavailable()end
  if kind=='count'then if not integer(value,100000)then error('Invalid enumeration count')end
  elseif kind=='boolean'then if type(value)~='boolean'then error('Invalid enumeration boolean')end
  elseif kind=='token'then value=text(value,true,false)
  elseif kind=='catalogue'then value=text(value,false,true)
  else value=text(value,false,false)end
  return captured(value)
end
local function collection(action,max,base,convert)
  local ok,list=pcall(action)
  if not ok or list==nil or list==false then return unavailable()end
  local count=dense(list,max);local result=base.array()
  for index=1,count do
    local valid,value=pcall(convert,list[index],index)
    if not valid then error(value)end
    if value==nil then return unavailable()end
    result[index]=value
  end
  return captured(result)
end
local function required_id(object)
  local result=observe(function()return object:GetUniqueId()end,'token')
  if result.status~='captured'then error('Enumeration object identity unavailable')end
  return result.value
end
local function media_info(item)
  local ok,media=pcall(function()return item:GetMediaPoolItem()end)
  if not ok or media==false then return{status='unavailable',id=NULL,nestedTimeline={status='unavailable',id=NULL}}end
  if media==nil then return{status='none',id=NULL,nestedTimeline={status='not-applicable',id=NULL}}end
  local id=observe(function()return media:GetUniqueId()end,'token')
  if id.status~='captured'then return{status='unavailable',id=NULL,nestedTimeline={status='unavailable',id=NULL}}end
  local read,nested=pcall(function()return media:GetTimeline()end)
  if not read or nested==false then return{status='captured',id=id.value,nestedTimeline={status='unavailable',id=NULL}}end
  if nested==nil then return{status='captured',id=id.value,nestedTimeline={status='leaf',id=NULL}}end
  local nested_id=observe(function()return nested:GetUniqueId()end,'token')
  return{status='captured',id=id.value,nestedTimeline=nested_id.status=='captured'and{status='timeline',id=nested_id.value}or{status='unavailable',id=NULL}}
end
local function effect_slot(effect)
  if type(effect)~='table'and type(effect)~='userdata'then error('Invalid enumeration effect object')end
  local ok,info=pcall(function()return effect:GetInfo()end)
  if ok and info~=nil and info~=false then
    if type(info)~='table'then error('Invalid enumeration effect info')end
    for key in pairs(info)do if key~='category'and key~='id'and key~='name'and key~='__flags'then error('Unknown enumeration effect info key')end end
  else info={}end
  return{category=observe(function()return info.category end,'token'),typeId=observe(function()return info.id end,'catalogue'),name=observe(function()return info.name end,'text'),
    index=observe(function()return effect:GetIndex()end,'count'),enabled=observe(function()return effect:GetIsEnabled()end,'boolean')}
end
local function read_once(resolve,base,max_items)
  local project=assert(resolve:GetProjectManager():GetCurrentProject(),'Open an enumeration project')
  local count,timelines,total_items,total_tracks,total_effects=observe(function()return project:GetTimelineCount()end,'count'),unavailable(),0,0,0
  if count.status=='captured'then
    if count.value>20 then error('Enumeration timeline bound exceeded')end
    local result=base.array()
    for ti=1,count.value do
      local ok,timeline=pcall(function()return project:GetTimelineByIndex(ti)end)
      if not ok or timeline==nil or timeline==false then error('Enumeration timeline object unavailable')end
      local row={index=ti,id=required_id(timeline),name=observe(function()return timeline:GetName()end,'text'),trackGroups=base.array()}
      for _,kind in ipairs(kinds)do
        local n,tracks=observe(function()return timeline:GetTrackCount(kind)end,'count'),unavailable()
        if n.status=='captured'then
          total_tracks=total_tracks+n.value;if total_tracks>200 then error('Enumeration track bound exceeded')end
          local list=base.array()
          for index=1,n.value do
            local items=collection(function()return timeline:GetItemListInTrack(kind,index)end,max_items,base,function(item)
              total_items=total_items+1;if total_items>max_items then error('Enumeration item bound exceeded')end
              local entry={id=required_id(item),type=observe(function()return item:GetType()end,'token'),name=observe(function()return item:GetName()end,'text'),mediaPool=media_info(item),effects=base.array(),
                linkedItemIds=collection(function()return item:GetLinkedItems()end,200,base,function(linked)local id=observe(function()return linked:GetUniqueId()end,'token');if id.status=='captured'then return id.value end;return nil end),
                fusionCompCount=observe(function()return item:GetFusionCompCount()end,'count'),fusionCompNames=collection(function()return item:GetFusionCompNameList()end,64,base,function(v)return text(v,false,false)end)}
              if entry.linkedItemIds.status=='captured'then table.sort(entry.linkedItemIds.value)end
              for _,category in ipairs(categories)do
                local slots=collection(function()return item:GetEffects(category)end,256,base,function(effect)total_effects=total_effects+1;if total_effects>1024 then error('Enumeration effect bound exceeded')end;return effect_slot(effect)end)
                entry.effects[#entry.effects+1]={category=category,slots=slots}
              end
              return entry
            end)
            list[index]={index=index,name=observe(function()return timeline:GetTrackName(kind,index)end,'text'),items=items}
          end
          tracks=captured(list)
        end
        row.trackGroups[#row.trackGroups+1]={type=kind,count=n,tracks=tracks}
      end
      result[ti]=row
    end
    timelines=captured(result)
  end
  return{projectId=required_id(project),timelineCount=count,timelines=timelines}
end
local function runtime(resolve)
  return{version=observe(function()return resolve:GetVersionString()end,'text'),productName=observe(function()return resolve:GetProductName()end,'text'),isStudio=observe(function()return resolve:IsStudio()end,'boolean')}
end
local function active_id(resolve)
  local ok,value=pcall(function()local p=resolve:GetProjectManager():GetCurrentProject();local timeline=p:GetCurrentTimeline();return timeline and timeline:GetUniqueId()end)
  if not ok then return unavailable()end
  if value==nil then return captured(NULL)end
  return captured(text(value,true,false))
end
local function compatible(tree)
  if tree.timelines.status~='captured'then return false end
  for _,t in ipairs(tree.timelines.value)do for _,g in ipairs(t.trackGroups)do if g.tracks.status~='captured'then return false end
    for _,track in ipairs(g.tracks.value)do if track.items.status~='captured'then return false end
      for _,item in ipairs(track.items.value)do if item.type.status~='captured'or(item.type.value~='video'and item.type.value~='audio'and item.type.value~='transition'and item.type.value~='subtitle')then return false end end
    end
  end end
  return true
end
local function capture(resolve,base,effects,config,max_items)
  if not integer(max_items,200)or max_items<1 then error('Invalid enumeration item bound')end
  local encode=effects.encode;local build=runtime(resolve);local active=active_id(resolve);local page=observe(function()return resolve:GetCurrentPage()end,'token')
  local first,rich=read_once(resolve,base,max_items),unavailable()
  if compatible(first)then local ok,value=pcall(function()return effects.capture(resolve,base,config)end);if ok and value~=nil then rich=captured(value)end end
  local repeated=read_once(resolve,base,max_items)
  assert(encode(first)==encode(repeated),'Enumeration changed during capture')
  if rich.status=='captured'then local ok,value=pcall(function()return effects.capture(resolve,base,config)end);assert(ok and encode(value)==encode(rich.value),'Enumeration rich context changed')end
  assert(encode(build)==encode(runtime(resolve))and encode(active)==encode(active_id(resolve))and encode(page)==encode(observe(function()return resolve:GetCurrentPage()end,'token')),'Enumeration context changed')
  return{schemaVersion=1,operation='resolve-timeline-enumeration',readOnly=true,safeToApply=false,runtime=build,projectId=first.projectId,timelineCount=first.timelineCount,timelines=first.timelines,
    richContext=rich,activeTimelineId=active,capturePage=page,capturePasses=2,representedContextUnchangedAcrossReads=true,scope='outer-timeline-constructs',effectIdentity='category-and-current-slot-only',internalGraphsEnumerated=false}
end
return{capture=capture}
