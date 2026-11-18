-- Test boundary only: distinct working/saved project state, no Resolve connection.
function copy(value) if type(value)~='table' then return value end local out={};for k,v in pairs(value) do out[k]=copy(v) end;return out end
working=copy(initial);saved=copy(initial);opened=true
counters={editor=0,setName=0,save=0,close=0,load=0,fileOpen=0,fileClose=0}
local function timelineData(id) for _,v in ipairs(working.snapshot.timelines) do if v.id==id then return v end end;error('Mock timeline missing') end
local function itemData(tid,id) for _,v in ipairs(timelineData(tid).items) do if v.id==id then return v end end;error('Mock item missing') end
local function supplementData(tid,id) for _,v in ipairs(working.items) do if v.timelineId==tid and v.itemId==id then return v end end;error('Mock supplement missing') end
local function trackData(tid,kind,index) for _,v in ipairs(working.tracks) do if v.timelineId==tid and v.type==kind and v.index==index then return v end end;error('Mock track missing') end
local itemObject
itemObject=function(tid,id)
 local item={}
 function item:GetUniqueId()return id end
 function item:GetName()return itemData(tid,id).name end
 function item:GetType()return itemData(tid,id).type end
 function item:GetStart()return itemData(tid,id).start_frame end
 function item:GetEnd()return itemData(tid,id).end_frame end
 function item:GetSourceStartFrame()return itemData(tid,id).source_start_frame end
 function item:GetSourceEndFrame()return itemData(tid,id).source_end_frame end
 function item:GetMediaPoolItem()local mid=itemData(tid,id).media_pool_id;if mid then return {GetUniqueId=function()return mid end} end;return nil end
 function item:GetLinkedItems()local out={};for _,linked in ipairs(itemData(tid,id).linked_item_ids) do out[#out+1]=itemObject(tid,linked) end;return out end
 function item:GetProperties()
  local record=supplementData(tid,id);if record.propertyReadStatus=='unavailable' then error('Mock unavailable properties') end
  local out={};for key,value in pairs(record.properties) do out[key]=type(value)=='table' and tonumber(value.decimal) or value end;return out
 end
 function item:GetEffects(category)
  local out={};for _,entry in ipairs(supplementData(tid,id).effects) do if entry.category==category then
   out[#out+1]={GetInfo=function()return {category=entry.category,id=entry.typeId,name=entry.name} end,GetIsEnabled=function()return entry.enabled end,GetIndex=function()return entry.index end}
  end end;return out
 end
 function item:SetName(name)
  counters.setName=counters.setName+1
  if options.failSetNameAt==counters.setName then return false end
  itemData(tid,id).name=name
  if counters.setName==1 and options.collateral=='pan' then supplementData(tid,id).properties.Pan={decimal='1.3250000000000000e+01'} end
  if counters.setName==1 and options.collateral=='effect' then supplementData(tid,id).effects[1].enabled=not supplementData(tid,id).effects[1].enabled end
  return true
 end
 return item
end
local function timelineObject(id)
 local timeline={}
 function timeline:GetUniqueId()return id end
 function timeline:GetName()return timelineData(id).name end
 function timeline:GetStartFrame()return timelineData(id).start_frame end
 function timeline:GetTrackCount(kind)local n=0;for _,track in ipairs(timelineData(id).tracks) do if track.type==kind then n=math.max(n,track.index) end end;return n end
 function timeline:GetTrackName(kind,index)for _,v in ipairs(timelineData(id).tracks) do if v.type==kind and v.index==index then return v.name end end;error('Mock track missing') end
 function timeline:GetIsTrackEnabled(kind,index)return trackData(id,kind,index).enabled end
 function timeline:GetIsTrackLocked(kind,index)return trackData(id,kind,index).locked end
 function timeline:GetItemListInTrack(kind,index)local out={};for _,v in ipairs(timelineData(id).items) do if v.track_type==kind and v.track_index==index then out[#out+1]=itemObject(id,v.id) end end;return out end
 return timeline
end
local project={}
function project:GetUniqueId()return working.snapshot.project_id end
function project:GetName()return working.snapshot.project_name end
function project:GetTimelineCount()return #working.snapshot.timelines end
function project:GetTimelineByIndex(index)return timelineObject(working.snapshot.timelines[index].id) end
function project:GetCurrentTimeline()if working.activeTimelineId then return timelineObject(working.activeTimelineId) end end
local manager={}
function manager:GetCurrentProject()return opened and project or nil end
function manager:SaveProject()counters.save=counters.save+1;if options.failSaveAt==counters.save or options.failAllSaves then return false end;saved=copy(working);return true end
function manager:CloseProject(value)counters.close=counters.close+1;if options.failCloseAt==counters.close then return false end;assert(value==project);opened=false;return true end
function manager:LoadProject(name)counters.load=counters.load+1;if options.failLoadAt==counters.load then return nil end;assert(name==saved.snapshot.project_name);working=copy(saved);opened=true;return project end
resolve={}
function resolve:GetProjectManager()counters.editor=counters.editor+1;return manager end
function resolve:GetVersionString()return working.snapshot.resolve_version end
local hostIO=io
bmd={fileexists=function(filename)local handle=hostIO.open(filename,'rb');if not handle then return false end;handle:close();return true end}
-- The emitted command sees only the documented Fusion IOClass surface.
-- The test shim's host IO is a private filesystem adapter, not Console io.
function resolve:Fusion()
 if options.noFusion then return nil end
 return {OpenFile=function(_,filename,mode)
  assert(mode==1,'Mock reader mode differs from the native read-only probe')
  local handle=hostIO.open(filename,'rb');if not handle then return nil end
  counters.fileOpen=counters.fileOpen+1
  local reader={};local size=handle:seek('end');handle:seek('set',0)
  function reader:GetFileSize()return size+(options.readerSizeDelta or 0) end
  function reader:ReadLine()
   if options.readerNoProgress then return '' end
   local parts={};while true do local byte=handle:read(1);if not byte then break end;parts[#parts+1]=byte;if byte=='\n' then break end end
   if #parts==0 then return nil end
   local value=table.concat(parts);if options.readerStripsNewline then value=value:gsub('\n$','') end;return value
  end
  function reader:Close()counters.fileClose=counters.fileClose+1;handle:close();if options.readerCloseFailure then error('Mock close failed') end end
  return reader
 end}
end

if options.noIo then io=nil end
