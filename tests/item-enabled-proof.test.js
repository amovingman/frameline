'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const{gunzipSync}=require('node:zlib'),{createHash}=require('node:crypto');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const{getSources,projectName,projectId}=require('../phase-0/prepare-item-state-menu');
const{renderItemEnabledProof,readItemEnabledProof,states,targetItemId}=require('../phase-0/prepare-item-enabled-proof');
const{compareItemStateObservations}=require('../src/resolve-item-state-observation');
const sha=value=>createHash('sha256').update(value).digest('hex');
const extra=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/item-state-evidence/ordered-baseline.json.gz'))));
const rich=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/item-state-evidence/baseline-rich.json.gz'))));
const library='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
function lua(value){if(value===null)return'nil';if(Array.isArray(value))return`{${value.map(lua).join(',')}}`;if(value&&typeof value==='object')return`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`;return JSON.stringify(value);}
async function setup(t,mode='disable'){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'frameline-enabled-proof-test-')));fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const paths=Object.fromEntries(Object.entries({result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json',baseline:'baseline-observation.json',baselineExtra:'baseline-extra.json',baselineRich:'baseline-rich.json',sourceExtra:'source-extra.json',backup:'baseline.drp',afterBackup:'post-state.drp',ready:'ready.json',started:'started.json',richResult:'rich-result.json'}).map(([k,v])=>[k,path.join(directory,v)]));
  const id='f'.repeat(32),sources=await getSources(),expected=states(extra,rich,mode),backup=Buffer.from('archive fixture');
  const record={schemaVersion:1,operation:'prepare-item-enabled-proof',id,directory,paths,projectName,projectId,mode,backup:{archiveVerified:true,size:backup.length,sha256:sha(backup)},
    sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(v)])),sourcePath:path.join(directory,`Frameline Enabled Proof ${id.slice(0,12)}.lua`),installedPath:null,
    readyBytes:JSON.stringify({schemaVersion:1,operation:'item-enabled-ready',id,mode})+'\n',startedBytes:JSON.stringify({schemaVersion:1,operation:'item-enabled-started',id,mode})};
  for(const[name,value]of[['baselineExtra',extra],['baselineRich',rich],['sourceExtra',expected.before]]){const raw=JSON.stringify(value)+'\n';fs.writeFileSync(paths[name],raw,{mode:0o600});record[`${name}Sha256`]=sha(raw);}
  fs.writeFileSync(paths.backup,backup,{mode:0o600});fs.writeFileSync(paths.ready,record.readyBytes,{mode:0o600});
  const source=renderItemEnabledProof(sources,record,extra,rich);record.sourceSha256=sha(source);fs.writeFileSync(record.sourcePath,source,{mode:0o600});
  const file=path.join(directory,'enabled-preparation.json');fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});return{record,source,file};
}
function prefix(record){return`local descriptor=${lua(rich)};local extras=${lua(extra)};local enabled=${record.mode==='disable'?'true':'false'};local mutations=0;local saves=0;local closes=0;local loads=0;local exports=0;local fail_save=false;local wrong_source=false;local files={}
files[${JSON.stringify(record.paths.ready)}]=${JSON.stringify(record.readyBytes)};files[${JSON.stringify(record.paths.backup)}]=${JSON.stringify('archive fixture')}
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';return #value+1 end;function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local s=files[name]:sub(self.offset);self.offset=#files[name]+1;return s end;return h end
local function numeric(values)local copy={};for k,v in pairs(values)do if type(v)=='table'and v.decimal then copy[k]=tonumber(v.decimal)else copy[k]=v end end;return copy end
local meta=descriptor.snapshot.timelines[1];local timeline={};function timeline:GetUniqueId()return meta.id end;function timeline:GetName()return meta.name end;function timeline:GetStartFrame()return meta.start_frame end
function timeline:GetTrackCount(kind)local n=0;for _,v in ipairs(meta.tracks)do if v.type==kind then n=n+1 end end;return n end
function timeline:GetTrackName(kind,index)for _,v in ipairs(meta.tracks)do if v.type==kind and v.index==index then return v.name end end end
function timeline:GetIsTrackEnabled(kind,index)for _,v in ipairs(descriptor.tracks)do if v.type==kind and v.index==index then return v.enabled end end end;function timeline:GetIsTrackLocked(kind,index)for _,v in ipairs(descriptor.tracks)do if v.type==kind and v.index==index then return v.locked end end end
function timeline:GetItemListInTrack(kind,index)local found={};for _,v in ipairs(meta.items)do if v.track_type==kind and v.track_index==index then local item={};local supplement;for _,x in ipairs(extras.items)do if x.itemId==v.id then supplement=x end end
function item:GetUniqueId()return v.id end;function item:GetName()return v.name end;function item:GetType()return v.type end;function item:GetStart()return v.start_frame end;function item:GetEnd()return v.end_frame end;function item:GetSourceStartFrame()return v.source_start_frame end;function item:GetSourceEndFrame()return v.source_end_frame end
function item:GetMediaPoolItem()return{GetUniqueId=function()return v.media_pool_id end}end;function item:GetLinkedItems()return{}end;function item:GetEffects()return{__flags=0}end
function item:GetProperties()for _,p in ipairs(descriptor.items)do if p.itemId==v.id then local values=numeric(p.properties);if wrong_source then values.Pan=13.25 end;return values end end end
function item:GetClipEnabled()if v.id==${JSON.stringify(targetItemId)}then return enabled end;return supplement.clipEnabled.value end
function item:SetClipEnabled(value)assert(v.id==${JSON.stringify(targetItemId)},'Wrong mutation target');mutations=mutations+1;enabled=value;return true end
function item:GetSpeed()return numeric(supplement.speed.value)end;function item:GetFades()return numeric(supplement.fades.value)end;function item:GetOutputBlanking()return numeric(supplement.outputBlanking.value)end;function item:GetUseTimelineForOutputBlanking()return supplement.usesTimelineOutputBlanking.value end;function item:GetFusionCompCount()return supplement.fusionCompCount.value end;function item:GetNodeGraph()return{GetNumNodes=function()return supplement.firstColorLayerNodeCount.value end}end
found[#found+1]=item end end;return found end
local project={};function project:GetName()return descriptor.snapshot.project_name end;function project:GetUniqueId()return descriptor.snapshot.project_id end;function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
local pm={};function pm:GetCurrentProject()return project end;function pm:SaveProject()saves=saves+1;return not fail_save end;function pm:CloseProject()closes=closes+1;return true end;function pm:LoadProject()loads=loads+1;return project end;function pm:ExportProject(name,file)exports=exports+1;files[file]='mock archive';return true end
resolve={};function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProjectManager()return pm end;function resolve:GetCurrentPage()return'color'end;function resolve:Fusion()return fusion end
`;}
function suffix(record){return`print('MUTATIONS:'..mutations);print('SAVES:'..saves);print('CLOSES:'..closes);print('LOADS:'..loads);print('EXPORTS:'..exports);print('MOCK_RESULT:'..(files[${JSON.stringify(record.paths.result)}]or'absent'));print('MOCK_FAILURE:'..(files[${JSON.stringify(record.paths.failure)}]or'absent'));print('MOCK_EXTRA:'..(files[${JSON.stringify(record.paths.observation)}]or'absent'));print('MOCK_RICH:'..(files[${JSON.stringify(record.paths.richResult)}]or'absent'))`;}
function run(record,source,alteration='',replay=false){return runVendorLuaMock(prefix(record)+'\n'+alteration+'\n'+source+(replay?'\n'+source:'')+'\n'+suffix(record),{library,maxBuffer:4*1024*1024});}
test('proof phases require baseline-only enabled flag differences and an independent restore source',()=>{
  const expected=states(extra,rich,'disable');assert.equal(expected.before.items.find(i=>i.itemId===targetItemId).clipEnabled.value,true);assert.equal(expected.after.items.find(i=>i.itemId===targetItemId).clipEnabled.value,false);
  const delta=compareItemStateObservations(JSON.stringify(expected.before),JSON.stringify(expected.after));assert.equal(delta.itemStateChanges.length,1);assert.equal(delta.itemStateChanges[0].field,'clipEnabled');assert.deepEqual(delta.snapshotChanges,[]);assert.throws(()=>states(extra,rich,'unknown'));
});
test('vendor Lua proves one enabled write/save/reopen/export per phase, rejects stale sources and replay, retains failed started mutation',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
    for(const mode of['disable','restore']){const{record,source}=await setup(t,mode),good=run(record,source,'',true);assert.equal(good.status,0,good.stderr);assert(good.stdout.includes('MUTATIONS:1'),good.stdout.slice(0,500));assert(good.stdout.includes('SAVES:1'));assert(good.stdout.includes('CLOSES:1'));assert(good.stdout.includes('LOADS:1'));assert(good.stdout.includes('EXPORTS:1'));const result=JSON.parse(good.stdout.split('\n').find(x=>x.startsWith('MOCK_RESULT:')).slice(12));assert.equal(result.mode,mode);assert.equal(result.enabled,mode==='restore');assert.equal(result.experimental,true);assert.equal(result.safeToApply,false);}
    const{record,source}=await setup(t);const stale=run(record,source,'wrong_source=true;');assert.equal(stale.status,0);assert(stale.stdout.includes('MUTATIONS:0'));assert(stale.stdout.includes('MOCK_RESULT:absent'));
    const wrongProject=run(record,source,"function project:GetUniqueId()return'wrong'end;");assert.equal(wrongProject.status,0);assert(wrongProject.stdout.includes('MUTATIONS:0'));
    const missingBackup=run(record,source,`files[${JSON.stringify(record.paths.backup)}]=nil;`);assert.equal(missingBackup.status,0);assert(missingBackup.stdout.includes('MUTATIONS:0'));
    const failure=run(record,source,'fail_save=true;');assert.equal(failure.status,0);assert(failure.stdout.includes('MUTATIONS:1'));assert(failure.stdout.includes('MOCK_RESULT:absent'));const receipt=JSON.parse(failure.stdout.split('\n').find(x=>x.startsWith('MOCK_FAILURE:')).slice(13));assert.equal(receipt.mutationAttempted,true);assert.equal(receipt.stage,'save-reopen');assert.equal(receipt.errorCode,'operation-failed');
  });
test('host refuses forged source, changed backup, absent completion and symlink alias without changing unrelated modes',async t=>{
  const{record,source,file}=await setup(t);
  await assert.rejects(readItemEnabledProof(file));fs.writeFileSync(record.sourcePath,source+'\n-- changed');record.sourceSha256=sha(source+'\n-- changed');fs.writeFileSync(file,JSON.stringify(record));await assert.rejects(readItemEnabledProof(file),/program-changed/);
  fs.writeFileSync(record.sourcePath,source);record.sourceSha256=sha(source);fs.writeFileSync(file,JSON.stringify(record));fs.writeFileSync(record.paths.backup,'changed');await assert.rejects(readItemEnabledProof(file),/backup-changed/);
  const resultMode=path.join(record.directory,'result.json');fs.writeFileSync(resultMode,'untouched',{mode:0o644});
  const alias=path.join(record.directory,'parent-alias');fs.symlinkSync(path.dirname(record.directory),alias);const aliasedDirectory=path.join(alias,path.basename(record.directory)),oldDirectory=record.directory;
  record.directory=aliasedDirectory;record.sourcePath=record.sourcePath.replace(oldDirectory,aliasedDirectory);for(const key of Object.keys(record.paths))record.paths[key]=record.paths[key].replace(oldDirectory,aliasedDirectory);fs.writeFileSync(file,JSON.stringify(record));
  await assert.rejects(readItemEnabledProof(path.join(aliasedDirectory,'enabled-preparation.json')),/unsafe-enabled-proof-directory/);assert.equal(fs.statSync(resultMode).mode&0o777,0o644);
});
