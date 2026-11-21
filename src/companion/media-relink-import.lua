-- Creates and checks only a NEW derived review project. Never loads an existing
-- project by name, relinks its originals, or claims lossless native SDK save.
local fusion=assert(resolve:Fusion(),'Fusion unavailable')
@@ENCODER@@
local function absent(file)local h=fusion:OpenFile(file,1);if h then h:Close();error('Retained output exists')end end
local function read_exact(file,value)local h=assert(fusion:OpenFile(file,1),'Bound input absent');local parts,n={},0;while n<#value do local s=h:ReadLine();assert(type(s)=='string'and #s>0 and n+#s<=#value,'Bound input changed');parts[#parts+1]=s;n=n+#s end;assert(h:ReadLine()==nil,'Input grew');h:Close();assert(table.concat(parts)==value,'Bound input changed')end
local function write_exact(file,value)absent(file);local h=assert(fusion:OpenFile(file,2),'Writer absent');assert(h:WriteLine(value)==#value+1,'Write failed');assert(h:Flush()==true,'Flush failed');h:Close();read_exact(file,value..'\n')end
local function live()absent(@@RETIRED@@);read_exact(@@CONFIG_PATH@@,@@CONFIG_BYTES@@)end
local token,request_sha=@@TOKEN@@,@@REQUEST_SHA@@
local function ticket(file,phase)local prefix='FRAMELINE_MEDIA_IMPORT:'..token..':'..request_sha..':'..phase..':'
 for poll=1,1200 do live();local h=fusion:OpenFile(file,1);if h then local value=h:ReadLine();assert(type(value)=='string','Ticket absent');local rest=h:ReadLine();h:Close();assert(rest==nil and value:sub(1,#prefix)==prefix,'Ticket differs');local receipt=value:sub(#prefix+1):gsub('\n$','');assert(#receipt==64 and receipt:match('^[a-f0-9]+$'),'Ticket receipt');return receipt end;bmd.wait(0.1)end;error('Host admission timeout')end
local stage='admission';local may_report=false
local ok,err=pcall(function()
 for _,file in ipairs({@@OUTPUT_FILES@@})do absent(file)end
 read_exact(@@REQUEST_PATH@@,@@REQUEST_BYTES@@);live()
 may_report=true;assert(resolve:GetVersionString()=='21.1.2.10'and resolve:GetProductName()=='DaVinci Resolve'and resolve:IsStudio()==false,'Unsupported Resolve')
 local pm=assert(resolve:GetProjectManager(),'Manager absent')
 local db=assert(pm:GetCurrentDatabase(),'Database absent');assert(db.DbName==@@DATABASE_NAME@@ and db.DbType=='Disk'and pm:GetCurrentFolder()=='','Choose the prepared disk library root')
 local function empty_workspace()
  live();local current=pm:GetCurrentProject();local kind='absent';local name='';local clips,folders=0,0
  if current~=nil and current~=false then
   kind='unsaved-empty';name=current:GetName();assert(name=='Untitled Project'and current:GetTimelineCount()==0,'Close the saved project before creating a review');local active=current:GetCurrentTimeline();assert(active==nil or active==false,'Blank workspace has a timeline')
   local root=assert(current:GetMediaPool():GetRootFolder(),'Blank root unavailable')
   local function count(value)assert(type(value)=='table','Blank inventory unavailable');local n=0;for key in pairs(value)do if key~='__flags'then n=n+1 end end;return n end
   clips=count(root:GetClipList());folders=count(root:GetSubFolderList());assert(clips==0 and folders==0,'Blank workspace has media')
  end
  local names=assert(pm:GetProjectListInCurrentFolder(),'Saved list unavailable');assert(type(names)=='table','Saved list invalid');local n,max=0,0;for key,value in pairs(names)do if key~='__flags'then assert(type(key)=='number'and key>=1 and key%1==0 and type(value)=='string','Saved list invalid');n=n+1;max=math.max(max,key);if name~=''then assert(value~=name,'Blank name is a saved project')end end end;assert(n==#names and max==n,'Saved list incomplete')
  local current_db=assert(pm:GetCurrentDatabase(),'Database absent');assert(current_db.DbName==@@DATABASE_NAME@@ and current_db.DbType=='Disk'and pm:GetCurrentFolder()=='','Prepared library changed')
  return{kind=kind,projectName=name,timelineCount=0,currentTimelineAbsent=true,rootClipEntries=clips,rootFolderEntries=folders,sameNameSaved=false,currentFolder='Root'}
 end
 local blank=empty_workspace()
 for _,name in ipairs(pm:GetProjectListInCurrentFolder())do assert(name~=@@PROJECT_NAME@@,'Review project already exists')end
 write_exact(@@STARTED@@,token..':'..request_sha)
 write_exact(@@READY_ZERO@@,encode({token=token,requestSha256=request_sha,phase=0,workspace=blank}))
 stage='host-before-create';local receipt_zero=ticket(@@TICKET_ZERO@@,'0');empty_workspace()
 stage='create-new-project';live();local project=assert(pm:CreateProject(@@PROJECT_NAME@@),'Create failed');local project_id=assert(project:GetUniqueId(),'Project ID absent');assert(project:GetName()==@@PROJECT_NAME@@ and project:GetTimelineCount()==0,'New empty project differs')
 local function derived_current()live();local current=assert(pm:GetCurrentProject(),'Derived project absent');assert(current:GetUniqueId()==project_id and current:GetName()==@@PROJECT_NAME@@,'Derived current project differs');return current end
 derived_current();assert(project:SetSetting('timelineFrameRate',@@FRAME_RATE@@)==true,'Review frame rate failed');derived_current();assert(pm:SaveProject()==true,'Initial review save failed')
 write_exact(@@READY_ONE@@,encode({token=token,requestSha256=request_sha,phase=1,projectId=project_id,projectName=project:GetName(),timelineCount=0}))
 stage='host-before-import';local receipt_one=ticket(@@TICKET_ONE@@,'1')
 assert(pm:GetCurrentProject():GetUniqueId()==project_id,'Project changed');stage='import-new-review';derived_current();local timeline=assert(project:GetMediaPool():ImportTimelineFromFile(@@COPY_PATH@@),'Import failed');assert(project:GetTimelineCount()==1,'Imported timeline count differs')
 local expected=@@EXPECTED_CLIPS@@
 local function collect(link_proxies)
  assert(pm:GetCurrentProject():GetUniqueId()==project_id and project:GetName()==@@PROJECT_NAME@@,'Project differs');assert(project:GetTimelineCount()==1,'Timeline count differs');local t=assert(project:GetTimelineByIndex(1),'Timeline absent');assert(t:GetTrackCount('video')==1,'Picture tracks differ')
  local items=assert(t:GetItemListInTrack('video',1),'Items absent');assert(#items==#expected,'Picture count differs');local rows=array();local ids={};local pool_roles={}
  for index,item in ipairs(items)do local e=expected[index];local media=assert(item:GetMediaPoolItem(),'Media absent');local props=assert(media:GetClipProperty(),'Media properties absent');assert(props['File Path']==e.originalPath,'Original path differs');local pool_id=assert(media:GetUniqueId(),'Pool ID absent')
   if e.proxyPath~=''and props['Proxy Media Path']~=e.proxyPath then assert(link_proxies,'Proxy association differs');derived_current();assert(media:LinkProxyMedia(e.proxyPath)==true,'Proxy link failed');assert(media:GetUniqueId()==pool_id,'Proxy changed media identity');props=assert(media:GetClipProperty(),'Properties absent')end
   assert((props['Proxy Media Path']or'')==e.proxyPath,'Proxy path differs');local item_id=assert(item:GetUniqueId(),'Item ID absent');assert(not ids[item_id],'Duplicate occurrence');ids[item_id]=true
   local role=pool_roles[pool_id];if role then assert(role.originalPath==e.originalPath and role.proxyPath==e.proxyPath,'Shared source roles differ')else pool_roles[pool_id]={originalPath=e.originalPath,proxyPath=e.proxyPath}end
   local offset=item:GetStart()-t:GetStartFrame();local duration=item:GetDuration();local source_in=item:GetSourceStartFrame();assert(offset==e.offsetFrames and duration==e.durationFrames and source_in==e.sourceInFrames,'Timeline timing differs')
   rows[#rows+1]={itemId=item_id,mediaPoolId=pool_id,originalPath=props['File Path'],proxyPath=props['Proxy Media Path']or'',offsetFrames=offset,durationFrames=duration,sourceInFrames=source_in}
  end
  for track=1,t:GetTrackCount('audio')do local audio=t:GetItemListInTrack('audio',track);assert(not audio or #audio==0,'Unexpected audio items')end
  return{projectId=project_id,projectName=project:GetName(),timelineId=t:GetUniqueId(),clips=rows}
 end
 stage='verify-imported-roles';local before=collect(true);stage='save-new-review';derived_current();assert(pm:SaveProject()==true,'Review save failed');derived_current();assert(pm:CloseProject(project)==true,'Review close failed');empty_workspace();project=assert(pm:LoadProject(@@PROJECT_NAME@@),'Review reopen failed');assert(project:GetUniqueId()==project_id,'Reopened project differs');local reopened=collect(false);assert(encode(before)==encode(reopened),'Represented review changed on save/reopen')
 write_exact(@@READY_TWO@@,encode({token=token,requestSha256=request_sha,phase=2,projectId=project_id,projectName=project:GetName(),timelineCount=1}))
 stage='host-after-reopen';local receipt_two=ticket(@@TICKET_TWO@@,'2');local final=collect(false);assert(encode(before)==encode(final),'Review changed during admission');live();derived_current();assert(pm:CloseProject(project)==true,'Final review close failed')
 write_exact(@@RESULT@@,encode({schemaVersion=1,operation='fcpxml-derived-proxy-review-result',token=token,requestSha256=request_sha,projectId=project_id,projectName=@@PROJECT_NAME@@,before=before,after=final,hostAdmissionReceiptZero=receipt_zero,hostAdmissionReceiptOne=receipt_one,hostAdmissionReceiptTwo=receipt_two,newDerivedProjectOnly=true,existingProjectWritten=false,originalMediaRelinkPerformed=false,proxyLinksAllowedOnlyInNewReview=true,savedReopened=true,closed=true,losslessNativeImportProven=false}))
end)
if not ok and may_report then write_exact(@@ERROR@@,encode({token=token,requestSha256=request_sha,stage=stage,message=tostring(err)}))elseif not ok then print('FRAMELINE_MEDIA_RELINK_IMPORT_REFUSED '..tostring(err))end
