'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {renderBlindCapture}=require('../phase-0/prepare-native-blind-capture');
const {runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const {parseApiLocationObservation,assessApiLocationWitnesses}=require('../src/resolve-api-location-observation');
const lua=value=>value===null?'{}':Array.isArray(value)?`setmetatable({${value.map(lua).join(',')}},{__array=true})`:value&&typeof value==='object'?`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`:JSON.stringify(value);
test('blind initializer builds fresh4V4A with52items, duplicate empty tracks, saves/reopens then captures before prediction',
{skip:!fs.existsSync('/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib')&&'Vendor Lua unavailable'},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frameline-blind-init-test-'));
 try{
  const input=path.join(directory,'input.fcpxml');fs.writeFileSync(input,'fixture-input');
  const record={stage:'initialize',inputPath:input,wavPath:path.join(directory,'audio.wav'),wavBytes:32,emptyBackupPath:path.join(directory,'empty.drp'),probeId:'a'.repeat(32),
    paths:{first:path.join(directory,'first.drp'),second:path.join(directory,'second.drp'),result:path.join(directory,'result.json'),marker:path.join(directory,'complete.txt')}};
  const source=await renderBlindCapture(record),project=randomUUID(),timeline=randomUUID();
  const pictures=Array.from({length:50},(_,index)=>({id:randomUUID(),track_type:'video',track_index:1,type:'video',name:'Repeated source',
    start_frame:index*48,end_frame:(index+1)*48,source_start_frame:0,source_end_frame:47}));
  const prefix=`local files={[${JSON.stringify(input)}]='fixture-input',[${JSON.stringify(record.wavPath)}]=string.rep('w',32)};local exports,saves,imports,closed=0,0,0,false;local video,audio=1,1;local names={};local items=${lua(pictures)};local exists=false
  local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1};function h:WriteLine(v)files[name]=v..'\\n';return #v+1 end;function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local v=files[name]:sub(self.offset);self.offset=#files[name]+1;return v end;return h end
  local timeline={};function timeline:GetUniqueId()return ${JSON.stringify(timeline)}end;function timeline:GetName()return 'Blind timeline'end;function timeline:GetStartFrame()return 0 end
  function timeline:GetTrackCount(kind)return kind=='video'and video or kind=='audio'and audio or 0 end
  function timeline:AddTrack(kind,sub)if kind=='video'then video=video+1 else assert(sub=='mono');audio=audio+1 end;return true end
  function timeline:SetTrackName(kind,index,name)names[kind..index]=name;return true end;function timeline:GetTrackName(kind,index)return names[kind..index]or'Default'end
  function timeline:GetIsTrackEnabled()return true end;function timeline:GetIsTrackLocked()return false end
  function timeline:GetItemListInTrack(kind,index)local result={};for _,v in ipairs(items)do if v.track_type==kind and v.track_index==index then local item={}
   function item:GetUniqueId()return v.id end;function item:GetType()return v.type end;function item:GetName()return v.name end;function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end
   function item:GetSourceStartFrame()return v.source_start_frame end;function item:GetSourceEndFrame()return v.source_end_frame end;function item:GetMediaPoolItem()return nil end;function item:GetLinkedItems()return{}end
   function item:GetEffects()return{}end;function item:GetProperties()return{Pan=0,TransformEnabled=true}end;function item:GetTrackTypeAndIndex()return{v.track_type,v.track_index}end
   function item:GetPosition(sub)assert(sub==false);return{trackType=v.track_type,trackIndex=v.track_index,startFrame=v.start_frame}end;result[#result+1]=item end end;return result end
  local pool={};function pool:ImportTimelineFromFile(filename)assert(filename==${JSON.stringify(input)});imports=imports+1;exists=true;return timeline end
  function pool:ImportMedia(paths)assert(paths[1]==${JSON.stringify(record.wavPath)});return{{}}end
  function pool:AppendToTimeline(rows)assert(#rows==2);for index,row in ipairs(rows)do assert(row.mediaType==2 and row.trackIndex==index+1 and row.recordFrame==(index-1)*48);items[#items+1]={id=index==1 and'${randomUUID()}'or'${randomUUID()}',track_type='audio',track_index=row.trackIndex,type='audio',name='Repeated audio',start_frame=row.recordFrame,end_frame=row.recordFrame+48,source_start_frame=0,source_end_frame=47}end;return{{},{}}end
  local p={};function p:GetName()return'Frameline Identity Blind Fixture 20261120'end;function p:GetUniqueId()return'${project}'end;function p:GetMediaPool()return pool end;function p:GetTimelineCount()return exists and 1 or 0 end
  function p:GetTimelineByIndex()return timeline end;function p:GetCurrentTimeline()return timeline end;function p:SetCurrentTimeline(v)assert(v==timeline);return true end
  local manager={};function manager:GetCurrentProject()if not closed then return p end end;function manager:SaveProject()saves=saves+1;return true end;function manager:CloseProject(v)assert(v==p);closed=true;return true end
  function manager:LoadProject(name)assert(name==p:GetName());closed=false;return p end;function manager:ExportProject(name,filename)assert(name==p:GetName());exports=exports+1;files[filename]='native';return true end
  resolve={};function resolve:GetProjectManager()return manager end;function resolve:Fusion()return fusion end;function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProductName()return'DaVinci Resolve'end;function resolve:IsStudio()return false end;function resolve:GetCurrentPage()return'color'end;`;
  const suffix=`print('RESULT:'..(files[${JSON.stringify(record.paths.result)}]or'absent'));print('COUNTS:'..video..':'..audio..':'..#items..':'..exports..':'..saves..':'..imports)`;
  const good=runVendorLuaMock(prefix+'\n'+source+'\n'+suffix,{maxBuffer:3*1024*1024});assert.equal(good.status,0,good.stderr);
  const line=good.stdout.split('\n').find(v=>v.startsWith('RESULT:'));assert(!line.endsWith('absent'),good.stdout);
  const result=JSON.parse(line.slice(7));assert.equal(result.after.items.length,52);assert.equal(result.after.tracks.length,8);
  assert.equal(assessApiLocationWitnesses(parseApiLocationObservation(JSON.stringify(result.apiLocationWitnesses))).requiredPopulatedKindsCapturedAndAgree,true);
  assert.match(good.stdout,/COUNTS:4:4:52:3:1:1/);
  const refuse=runVendorLuaMock(prefix+'\nexists=true\n'+source+'\n'+suffix,{maxBuffer:1024*1024});assert.equal(refuse.status,0,refuse.stderr);assert.match(refuse.stdout,/RESULT:absent/);assert.match(refuse.stdout,/COUNTS:1:1:50:0:0:0/);
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
