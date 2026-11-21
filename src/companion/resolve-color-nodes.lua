-- Separate first-layer slot reads. Slot indexes are not persistent node IDs.
-- No labels, LUT paths, graph connections, parameters or project writes.
local NULL = {}
local colors = {Orange=true,Apricot=true,Yellow=true,Lime=true,Olive=true,Green=true,Teal=true,Navy=true,Blue=true,Purple=true,Violet=true,Pink=true,Tan=true,Beige=true,Brown=true,Chocolate=true,['']=true}
local function integer(value, maximum)
  return type(value)=='number' and value==value and value>=0 and value%1==0 and value<=maximum
end
local function read(action, kind, base)
  local ok, value = pcall(action)
  if not ok or value==nil then return {status='unavailable',value=NULL} end
  if kind=='tools' then
    if type(value)~='table' then error('Invalid color-node tools') end
    local n=0
    for key in pairs(value) do
      if type(key)=='number' and key>=1 and key%1==0 then n=n+1
      elseif key~='__flags' then error('Invalid color-node tools') end
    end
    if n~=#value or n>128 then error('Invalid color-node tools') end
    local tools=base.array()
    for index=1,n do
      local tool=value[index]
      if type(tool)~='string' or #tool<1 or #tool>128 or not tool:match('^[A-Za-z_][A-Za-z0-9_.%-]*$') then error('Invalid color-node tool token') end
      tools[index]=tool
    end
    value=tools
  elseif kind=='color' then
    if type(value)~='string' or colors[value]~=true then error('Invalid color-node color') end
  elseif kind=='cache' then
    -- Keep the documented integer; no assumed enum-number mapping.
    if type(value)~='number' or value~=value or math.abs(value)>9007199254740991 or value%1~=0 then error('Invalid color-node cache mode') end
  end
  return {status='captured',value=value}
end
local function active_id(project)
  local current=project:GetCurrentTimeline()
  return current and current:GetUniqueId() or NULL
end
local function page_name(resolve)
  local ok,page=pcall(function()return resolve:GetCurrentPage()end)
  if not ok or page==nil then return NULL end
  if page~='media' and page~='photo' and page~='cut' and page~='edit' and page~='fusion' and page~='color' and page~='fairlight' and page~='deliver' then error('Invalid color-node page') end
  return page
end
local function entries(list)
  if type(list)~='table' then error('Invalid color-node item list') end
  local count=0
  for key in pairs(list) do
    if type(key)=='number' and key>=1 and key%1==0 then count=count+1
    elseif key~='__flags' then error('Invalid color-node item list') end
  end
  if count~=#list then error('Sparse color-node item list') end
  return count
end
local function read_once(resolve,base,page,max_nodes)
  local project=resolve:GetProjectManager():GetCurrentProject()
  local items,total=base.array(),0
  for ti=1,project:GetTimelineCount() do
    local timeline=project:GetTimelineByIndex(ti)
    for _,kind in ipairs({'video','audio','subtitle'}) do
      for track=1,timeline:GetTrackCount(kind) do
        local list=timeline:GetItemListInTrack(kind,track) or {}
        entries(list)
        for _,item in ipairs(list) do
          local observed={status='unavailable',count=NULL,nodes=NULL}
          if page=='color' then
            local ok,graph=pcall(function()return item:GetNodeGraph()end)
            if ok and graph~=nil then
              local count_ok,count=pcall(function()return graph:GetNumNodes()end)
              if count_ok and count~=nil then
                if not integer(count,256) or total+count>max_nodes then error('Color-node graph exceeds bound') end
                total=total+count
                local nodes=base.array()
                for node=1,count do
                  nodes[node]={index=node,
                    tools=read(function()return graph:GetToolsInNode(node)end,'tools',base),
                    color=read(function()return graph:GetNodeColor(node)end,'color',base),
                    cacheMode=read(function()return graph:GetNodeCacheMode(node)end,'cache',base)}
                end
                assert(graph:GetNumNodes()==count,'Color-node count changed during capture')
                observed={status='captured',count=count,nodes=nodes}
              end
            end
          end
          items[#items+1]={timelineId=timeline:GetUniqueId(),itemId=item:GetUniqueId(),graph=observed}
        end
      end
    end
  end
  table.sort(items,function(a,b)if a.timelineId~=b.timelineId then return a.timelineId<b.timelineId end;return a.itemId<b.itemId end)
  return items
end
local function capture(resolve,base,encode,max_items,max_nodes)
  if not integer(max_items,200) or max_items<1 or not integer(max_nodes,2048) or max_nodes<1 then error('Invalid color-node bound') end
  local project=assert(resolve:GetProjectManager():GetCurrentProject(),'Open a disposable project')
  local timelines=project:GetTimelineCount()
  if not integer(timelines,20) then error('Color-node timeline bound exceeded') end
  local count,tracks=0,0
  for ti=1,timelines do
    local timeline=project:GetTimelineByIndex(ti)
    for _,kind in ipairs({'video','audio','subtitle'}) do
      local n=timeline:GetTrackCount(kind)
      if not integer(n,200) or tracks+n>200 then error('Color-node track bound exceeded') end
      tracks=tracks+n
      for track=1,n do count=count+entries(timeline:GetItemListInTrack(kind,track) or {});if count>max_items then error('Color-node project exceeds bound') end end
    end
  end
  local page=page_name(resolve)
  local snapshot=base.capture(resolve)
  local active=active_id(project)
  local items=read_once(resolve,base,page,max_nodes)
  assert(encode(items)==encode(read_once(resolve,base,page,max_nodes)),'Color-node state changed during capture')
  assert(encode(page)==encode(page_name(resolve)),'Color-node page context changed')
  assert(base.encode(snapshot)==base.encode(base.capture(resolve)),'Color-node snapshot context changed')
  assert(encode(active)==encode(active_id(project)),'Color-node timeline context changed')
  assert(#items==count,'Color-node item membership changed')
  return {schemaVersion=1,operation='resolve-color-node-observation',readOnly=true,safeToApply=false,
    snapshot=snapshot,activeTimelineId=active,capturePage=page,items=items,capturePasses=2,
    representedStateUnchangedAcrossReads=true,graphScope='first-layer-node-slots',graphReadPolicy='color-page-only',
    nodeIdentity='capture-local-one-based-index',topologyObserved=false,persistentNodeIdsObserved=false,completeGraphObserved=false}
end
return {capture=capture}
