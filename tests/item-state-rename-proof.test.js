'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const{gunzipSync}=require('node:zlib'),{createHash}=require('node:crypto');
const{runVendorLuaMock}=require('../phase-0/run-vendor-lua-mock');
const{getSources,projectName,projectId}=require('../phase-0/prepare-item-state-menu');
const{renderItemStateRenameProof,readItemStateRenameProof,prepareItemStateRenameProof,states,targetItemId,originalName,renamedName}=require('../phase-0/prepare-item-state-rename-proof');
const{compareItemStateObservations}=require('../src/resolve-item-state-observation');
const sha=value=>createHash('sha256').update(value).digest('hex');
const extra=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/item-state-evidence/ordered-baseline.json.gz'))));
const rich=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/item-state-evidence/baseline-rich.json.gz'))));
const library='/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
function lua(value){if(value===null)return'nil';if(Array.isArray(value))return`{${value.map(lua).join(',')}}`;if(value&&typeof value==='object')return`{${Object.entries(value).map(([k,v])=>`[${JSON.stringify(k)}]=${lua(v)}`).join(',')}}`;return JSON.stringify(value);}
async function setup(t,mode='rename'){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'frameline-state-rename-proof-test-')));fs.chmodSync(directory,0o700);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const paths=Object.fromEntries(Object.entries({result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json',baseline:'baseline-observation.json',baselineExtra:'baseline-extra.json',baselineRich:'baseline-rich.json',sourceExtra:'source-extra.json',sourceRich:'source-rich.json',backup:'baseline.drp',afterBackup:'post-state.drp',ready:'ready.json',started:'started.json',richResult:'rich-result.json'}).map(([k,v])=>[k,path.join(directory,v)]));
  const id='f'.repeat(32),sources=await getSources(),expected=states(extra,rich,mode),backup=Buffer.from('archive fixture');
  const record={schemaVersion:1,operation:'prepare-item-state-rename-proof',id,directory,paths,projectName,projectId,mode,predecessor:null,backup:{archiveVerified:true,size:backup.length,sha256:sha(backup)},
    sourceHashes:Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(v)])),sourcePath:path.join(directory,`Frameline State Rename Proof ${id.slice(0,12)}.lua`),installedPath:null,
    readyBytes:JSON.stringify({schemaVersion:1,operation:'item-state-rename-ready',id,mode})+'\n',startedBytes:JSON.stringify({schemaVersion:1,operation:'item-state-rename-started',id,mode})};
  for(const[name,value]of[['baselineExtra',extra],['baselineRich',rich],['sourceExtra',expected.before],['sourceRich',expected.richBefore]]){const raw=JSON.stringify(value)+'\n';fs.writeFileSync(paths[name],raw,{mode:0o600});record[`${name}Sha256`]=sha(raw);}
  record.backupSourceBinding={extraSha256:record.sourceExtraSha256,richSha256:record.sourceRichSha256,archiveSha256:record.backup.sha256,association:'fresh-export-host-receipt-not-native-semantic-equivalence'};
  fs.writeFileSync(paths.backup,backup,{mode:0o600});fs.writeFileSync(paths.ready,record.readyBytes,{mode:0o600});
  const source=renderItemStateRenameProof(sources,record,extra,rich);record.sourceSha256=sha(source);fs.writeFileSync(record.sourcePath,source,{mode:0o600});
  const file=path.join(directory,'rename-preparation.json');fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});return{record,source,file};
}
function prefix(record){return`local descriptor=${lua(states(extra,rich,record.mode).richBefore)};local extras=${lua(states(extra,rich,record.mode).before)};local enabled=true;local mutations=0;local saves=0;local closes=0;local loads=0;local exports=0;local fail_save=false;local wrong_source=false;local post_write_drift=false;local barrier_drift=false;local page='color';local files={}
files[${JSON.stringify(record.paths.ready)}]=${JSON.stringify(record.readyBytes)};files[${JSON.stringify(record.paths.backup)}]=${JSON.stringify('archive fixture')}
local fusion={};function fusion:OpenFile(name,mode)if mode==1 and files[name]==nil then return nil end;if mode==2 then files[name]=''end;local h={offset=1};function h:WriteLine(value)files[name]=value..'\\n';if name==${JSON.stringify(record.paths.started)} and barrier_drift then enabled=false end;return #value+1 end;function h:Flush()return true end;function h:Close()end;function h:GetFileSize()return #files[name]end;function h:ReadLine()if self.offset>#files[name]then return nil end;local s=files[name]:sub(self.offset);self.offset=#files[name]+1;return s end;return h end
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
function item:SetName(value)assert(v.id==${JSON.stringify(targetItemId)},'Wrong mutation target');mutations=mutations+1;v.name=value;if post_write_drift then enabled=false end;return true end
function item:GetSpeed()return numeric(supplement.speed.value)end;function item:GetFades()return numeric(supplement.fades.value)end;function item:GetOutputBlanking()return numeric(supplement.outputBlanking.value)end;function item:GetUseTimelineForOutputBlanking()return supplement.usesTimelineOutputBlanking.value end;function item:GetFusionCompCount()return supplement.fusionCompCount.value end;function item:GetNodeGraph()return{GetNumNodes=function()return supplement.firstColorLayerNodeCount.value end}end
found[#found+1]=item end end;return found end
local project={};function project:GetName()return descriptor.snapshot.project_name end;function project:GetUniqueId()return descriptor.snapshot.project_id end;function project:GetTimelineCount()return 1 end;function project:GetTimelineByIndex()return timeline end;function project:GetCurrentTimeline()return timeline end
local pm={};function pm:GetCurrentProject()return project end;function pm:SaveProject()saves=saves+1;return not fail_save end;function pm:CloseProject()closes=closes+1;return true end;function pm:LoadProject()loads=loads+1;return project end;function pm:ExportProject(name,file)exports=exports+1;files[file]='mock archive';return true end
resolve={};function resolve:GetVersionString()return'21.1.2.10'end;function resolve:GetProjectManager()return pm end;function resolve:GetCurrentPage()return page end;function resolve:Fusion()return fusion end
`;}
function suffix(record){return`print('MUTATIONS:'..mutations);print('SAVES:'..saves);print('CLOSES:'..closes);print('LOADS:'..loads);print('EXPORTS:'..exports);print('MOCK_RESULT:'..(files[${JSON.stringify(record.paths.result)}]or'absent'));print('MOCK_FAILURE:'..(files[${JSON.stringify(record.paths.failure)}]or'absent'));print('MOCK_EXTRA:'..(files[${JSON.stringify(record.paths.observation)}]or'absent'));print('MOCK_RICH:'..(files[${JSON.stringify(record.paths.richResult)}]or'absent'));print('MOCK_STARTED:'..(files[${JSON.stringify(record.paths.started)}]or'absent'));print('MOCK_BACKUP:'..(files[${JSON.stringify(record.paths.backup)}]or'absent'))`;}
function run(record,source,alteration='',replay=false){return runVendorLuaMock(prefix(record)+'\n'+alteration+'\n'+source+(replay?'\n'+source:'')+'\n'+suffix(record),{library,maxBuffer:4*1024*1024});}
test('separate rename contract represents only a name delta while preserving seven-field/page/order observations',()=>{
  const expected=states(extra,rich,'rename'),delta=compareItemStateObservations(JSON.stringify(expected.before),JSON.stringify(expected.after));
  assert.equal(delta.snapshotChanges.length,1);assert.equal(delta.snapshotChanges[0].field,'name');assert.deepEqual(delta.itemStateChanges,[]);
  assert.equal(expected.sourceName,originalName);assert.equal(expected.resultName,renamedName);
  assert.deepEqual(states(extra,rich,'rollback').after,extra);assert.throws(()=>states(extra,rich,'unknown'));
  for(const field of['propertyReadStatus','enabled','locked']){const changed=structuredClone(rich);if(field==='propertyReadStatus')changed.items[0][field]='unavailable';else changed.tracks[0][field]=null;assert.throws(()=>states(extra,changed,'rename'),/incomplete-rich-baseline/);}
  for(const [key,value]of[['capturePage','edit'],['readOrderPolicy','unknown']]){const changed=structuredClone(extra);changed[key]=value;assert.throws(()=>states(changed,rich,'rename'));}
});
function line(result,key){return result.stdout.split('\n').find(x=>x.startsWith(key+':')).slice(key.length+1);}
function checked(record,source,alteration='',replay=false){const r=run(record,source,alteration,replay);assert.equal(r.status,0,r.stderr);return r;}
test('actual generated Lua preserves every represented field through independent rename and rollback; replay cannot repeat writes',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  for(const mode of['rename','rollback']){const{record,source}=await setup(t,mode),good=checked(record,source,'',true);
    for(const key of['MUTATIONS','SAVES','CLOSES','LOADS','EXPORTS'])assert.equal(line(good,key),'1');
    const result=JSON.parse(line(good,'MOCK_RESULT'));assert.equal(result.mode,mode);assert.equal(result.name,mode==='rename'?renamedName:originalName);assert.equal(result.experimental,true);assert.equal(result.safeToApply,false);
    assert.notEqual(line(good,'MOCK_STARTED'),'absent');assert.equal(line(good,'MOCK_BACKUP'),'archive fixture');
    const after=JSON.parse(line(good,'MOCK_EXTRA'));assert.deepEqual(after,states(extra,rich,mode).after);
  }
});
test('actual generated Lua blocks stale enabled state, page/order context, missing backup and a post-barrier hidden drift before setter',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  const{record,source}=await setup(t);
  for(const alteration of['enabled=false;','wrong_source=true;',"page='edit';",'barrier_drift=true;',`files[${JSON.stringify(record.paths.backup)}]=nil;`]){
    const stale=checked(record,source,alteration);assert.equal(line(stale,'MUTATIONS'),'0');assert.equal(line(stale,'SAVES'),'0');assert.equal(line(stale,'MOCK_RESULT'),'absent');
    const failure=JSON.parse(line(stale,'MOCK_FAILURE'));assert.equal(failure.mutationAttempted,false);
    if(alteration==='barrier_drift=true;'){assert.equal(failure.stage,'pre-write-recheck');assert.notEqual(line(stale,'MOCK_STARTED'),'absent');}
  }
});
test('actual generated Lua rejects independent changes in each of seven read families and detects hidden reopen drift',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  const{record,source}=await setup(t);
  const alterations=['enabled=false;','extras.items[1].speed.value.Percentage.decimal="5.0000000000000000e+01";',
    'extras.items[1].fades.value.FadeIn=2;','extras.items[1].outputBlanking.value.Top=2;',
    'extras.items[1].usesTimelineOutputBlanking.value=false;','extras.items[1].fusionCompCount.value=2;',
    'extras.items[1].firstColorLayerNodeCount.value=2;'];
  for(const alteration of alterations){const rejected=checked(record,source,alteration);assert.equal(line(rejected,'MUTATIONS'),'0',alteration);assert.equal(line(rejected,'MOCK_RESULT'),'absent');}
  const reopened=checked(record,source,'local load=pm.LoadProject;function pm:LoadProject(...)local p=load(self,...);extras.items[1].fusionCompCount.value=2;return p end;');
  assert.equal(line(reopened,'MUTATIONS'),'1');assert.equal(line(reopened,'LOADS'),'1');assert.equal(line(reopened,'EXPORTS'),'0');
  assert.equal(JSON.parse(line(reopened,'MOCK_FAILURE')).stage,'validation');assert.notEqual(line(reopened,'MOCK_STARTED'),'absent');
});
test('actual generated Lua retains started/backup and stops before save on post-write hidden drift; save failures require inspected recovery',
  {skip:!fs.existsSync(library)&&'Vendor Lua unavailable'},async t=>{
  const{record,source}=await setup(t);
  for(const [alteration,stage,saves]of[['post_write_drift=true;','post-write-validation','0'],['fail_save=true;','save','1']]){
    const failed=checked(record,source,alteration,true);assert.equal(line(failed,'MUTATIONS'),'1');assert.equal(line(failed,'SAVES'),saves);assert.equal(line(failed,'MOCK_RESULT'),'absent');assert.notEqual(line(failed,'MOCK_STARTED'),'absent');assert.equal(line(failed,'MOCK_BACKUP'),'archive fixture');
    const receipt=JSON.parse(line(failed,'MOCK_FAILURE'));assert.equal(receipt.mutationAttempted,true);assert.equal(receipt.stage,stage);assert.equal(receipt.errorCode,'operation-failed');
  }
});
test('host refuses altered source/backup and parent aliases; interrupted started output is recovery-required without clearing source or backup',async t=>{
  const{record,source,file}=await setup(t);
  await assert.rejects(prepareItemStateRenameProof({mode:'rollback',baselineExtraFile:record.paths.baselineExtra,baselineRichFile:record.paths.baselineRich,sourceExtraFile:record.paths.sourceExtra,sourceRichFile:record.paths.sourceRich,backupFile:record.paths.backup,expectedBackupSha256:record.backup.sha256}),/rollback-source-observations-required/);
  await assert.rejects(readItemStateRenameProof(file));
  fs.writeFileSync(record.paths.started,record.startedBytes+'\n',{mode:0o600});const interrupted=await readItemStateRenameProof(file);assert.equal(interrupted.status,'recovery-required');assert.equal(interrupted.stage,'retained-output-incomplete');assert.equal(fs.readFileSync(record.paths.backup,'utf8'),'archive fixture');assert(fs.existsSync(record.paths.started));
  fs.writeFileSync(record.sourcePath,source+'\n-- changed');record.sourceSha256=sha(source+'\n-- changed');fs.writeFileSync(file,JSON.stringify(record));await assert.rejects(readItemStateRenameProof(file),/program-changed/);
  fs.writeFileSync(record.sourcePath,source);record.sourceSha256=sha(source);fs.writeFileSync(file,JSON.stringify(record));fs.writeFileSync(record.paths.backup,'changed');await assert.rejects(readItemStateRenameProof(file),/backup-changed/);
  const resultMode=path.join(record.directory,'result.json');fs.writeFileSync(resultMode,'untouched',{mode:0o644});
  const alias=path.join(record.directory,'parent-alias');fs.symlinkSync(path.dirname(record.directory),alias);const aliasedDirectory=path.join(alias,path.basename(record.directory)),oldDirectory=record.directory;
  record.directory=aliasedDirectory;record.sourcePath=record.sourcePath.replace(oldDirectory,aliasedDirectory);for(const key of Object.keys(record.paths))record.paths[key]=record.paths[key].replace(oldDirectory,aliasedDirectory);fs.writeFileSync(file,JSON.stringify(record));
  await assert.rejects(readItemStateRenameProof(path.join(aliasedDirectory,'rename-preparation.json')),/unsafe-state-rename-proof-directory/);assert.equal(fs.statSync(resultMode).mode&0o777,0o644);
});
