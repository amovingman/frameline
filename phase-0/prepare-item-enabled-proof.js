'use strict';
// Separately reviewed experimental phases on one pinned disposable fixture.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const{createHash}=require('node:crypto');
const{prepareItemStateMenu,getSources,renderItemStateMenu,ownedBytes,projectName,projectId}=require('./prepare-item-state-menu');
const{parseItemStateObservation}=require('../src/resolve-item-state-observation');
const{parseEffectObservation}=require('../src/resolve-effect-observation');
const{inspectResolveProjectExport}=require('../src/resolve-project-export');
const targetItemId='ccb4c9a5-2189-4b81-82c9-bf099c49eec1';
const utility=path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const json=value=>JSON.stringify(canonical(value));
const q=JSON.stringify;
const basename=id=>`Frameline Enabled Proof ${id.slice(0,12)}.lua`;
function states(baselineExtra,baselineRich,mode){
  if(!['disable','restore'].includes(mode)||baselineExtra.snapshot.project_id!==projectId||baselineExtra.snapshot.project_name!==projectName
    ||baselineExtra.items.length!==50||baselineExtra.snapshot.timelines.length!==1||baselineExtra.snapshot.timelines[0].tracks.length!==5
    ||json(baselineExtra.snapshot)!==json(baselineRich.snapshot)||baselineRich.schemaVersion!==2)throw new Error('invalid-enabled-proof-baseline');
  const reference=baselineExtra.items.find(item=>item.itemId===targetItemId);
  const metadata=baselineExtra.snapshot.timelines.flatMap(t=>t.items).find(item=>item.id===targetItemId);
  if(!reference||reference.clipEnabled.status!=='captured'||reference.clipEnabled.value!==true||metadata?.name!=='asset-[00001-00048]-still.png')throw new Error('enabled-proof-target-mismatch');
  const disabled=structuredClone(baselineExtra);disabled.items.find(item=>item.itemId===targetItemId).clipEnabled.value=false;
  return{before:mode==='disable'?baselineExtra:disabled,after:mode==='disable'?disabled:baselineExtra,rich:baselineRich,sourceEnabled:mode==='disable',resultEnabled:mode==='restore',timelineId:reference.timelineId,targetName:metadata.name};
}
function renderItemEnabledProof(sources,record,baselineExtra,baselineRich){
  const expected=states(baselineExtra,baselineRich,record.mode),templateKey='phase-0/resolve-item-state-menu.lua',copied={...sources};
  const start="  stage = 'capture'",end='  local bytes = encode(observed)';const a=copied[templateKey].indexOf(start),b=copied[templateKey].indexOf(end,a);
  if(a<0||b<0)throw new Error('enabled-proof-template-changed');
  const action=`  stage='capture'
  local expected_rich_json=${q(json(expected.rich))}
  local expected_before_extra_json=${q(json(expected.before))}
  local expected_after_extra_json=${q(json(expected.after))}
  local function read_exact(filename,expected)local h=assert(fusion:OpenFile(filename,1),'Proof input unavailable');local ok,value=pcall(function()assert(h:GetFileSize()==#expected,'Proof input changed');local parts,n={},0;while n<#expected do local s=h:ReadLine();assert(type(s)=='string'and #s>0 and #s<=#expected-n,'Proof input changed');parts[#parts+1]=s;n=n+#s end;assert(h:ReadLine()==nil,'Proof input grew');return table.concat(parts)end);local closed=pcall(function()h:Close()end);assert(ok and closed and value==expected,'Proof input changed')end
  absent(${q(record.paths.started)});absent(${q(record.paths.richResult)})
  read_exact(${q(record.paths.ready)},${q(record.readyBytes)})
  local pm=resolve:GetProjectManager()
  local function target()local p=assert(pm:GetCurrentProject(),'No project');assert(p:GetUniqueId()==project_id and p:GetName()==project_name,'Wrong disposable project');for n=1,p:GetTimelineCount()do local t=p:GetTimelineByIndex(n);if t:GetUniqueId()==${q(expected.timelineId)}then for _,kind in ipairs({'video','audio','subtitle'})do for track=1,t:GetTrackCount(kind)do for _,item in ipairs(t:GetItemListInTrack(kind,track)or{})do if item:GetUniqueId()==${q(targetItemId)}then assert(item:GetName()==${q(expected.targetName)},'Target name changed');return item end end end end end end;error('Target item missing')end
  local function rich()return effects.capture(resolve,base,${require('../src/resolve-property-observation').propertyCaptureConfig()})end
  assert(encode(rich())==expected_rich_json,'Rich source changed')
  assert(encode(state.capture(resolve,base,encode,50))==expected_before_extra_json,'Additional source changed')
  assert(target():GetClipEnabled()==${expected.sourceEnabled},'Enabled source changed')
  do local h=assert(fusion:OpenFile(${q(record.paths.backup)},1),'Verified backup missing');local good=h:GetFileSize()==${record.backup.size};h:Close();assert(good,'Verified backup size changed')end
  write_exact(${q(record.paths.started)},${q(record.startedBytes)})
  mutation_attempted=true;stage='clip-enabled-write'
  assert(target():SetClipEnabled(${expected.resultEnabled}),'Clip enabled write failed')
  stage='save-reopen';assert(pm:SaveProject(),'Save failed');assert(pm:CloseProject(pm:GetCurrentProject()),'Close failed');assert(pm:LoadProject(project_name),'Reopen failed')
  assert(pm:GetCurrentProject():GetUniqueId()==project_id,'Reopened project changed')
  stage='validation';local rich_after=rich();local observed=state.capture(resolve,base,encode,50)
  assert(encode(rich_after)==expected_rich_json,'Rich result differs')
  assert(encode(observed)==expected_after_extra_json,'Additional result differs')
  stage='post-state-export';absent(${q(record.paths.afterBackup)});assert(pm:ExportProject(project_name,${q(record.paths.afterBackup)},false),'Post-state export failed')
  rich_after=rich();observed=state.capture(resolve,base,encode,50)
  assert(encode(rich_after)==expected_rich_json and encode(observed)==expected_after_extra_json,'Post-export represented state differs')
  write_exact(${q(record.paths.richResult)},encode(rich_after))
  local bytes=encode(observed)`;
  copied[templateKey]=copied[templateKey].slice(0,a)+action+copied[templateKey].slice(b+end.length);
  copied[templateKey]=copied[templateKey].replace("local stage = 'guard'","local stage = 'guard'\nlocal mutation_attempted=false")
    .replaceAll('readOnly = true','readOnly = false, experimental = true')
    .replace("operation = 'resolve-item-state-menu'","operation = 'resolve-item-enabled-proof'")
    .replace("operation = 'resolve-item-state-menu-failure'","operation = 'resolve-item-enabled-proof-failure'")
    .replace('observationBytes = #bytes','observationBytes = #bytes, mode = '+q(record.mode)+', targetItemId = '+q(targetItemId)+', enabled = '+String(expected.resultEnabled))
    .replace('stage = stage, errorCode = code','stage = stage, errorCode = code, mutationAttempted = mutation_attempted')
    .replace("if stage ~= 'capture' and stage ~= 'guard' then code = 'output-failed'", "if stage=='clip-enabled-write' or stage=='save-reopen' or stage=='validation' or stage=='post-state-export' then code='operation-failed' elseif stage ~= 'capture' and stage ~= 'guard' then code = 'output-failed'")
    .replaceAll('FRAMELINE_ITEM_STATE_MENU_','FRAMELINE_ITEM_ENABLED_PROOF_');
  return renderItemStateMenu(copied,record,baselineRich.snapshot);
}
async function prepareItemEnabledProof({baselineExtraFile,baselineRichFile,backupFile,expectedBackupSha256,mode,sourceExtraFile=null,install=false}={}){
  if(!/^[a-f0-9]{64}$/.test(expectedBackupSha256||''))throw new Error('enabled-proof-backup-hash-required');
  const extraRaw=await ownedBytes(baselineExtraFile,2*1024*1024),richRaw=await ownedBytes(baselineRichFile,2*1024*1024),extra=parseItemStateObservation(extraRaw),rich=parseEffectObservation(richRaw),expected=states(extra,rich,mode);
  if(mode==='restore'&&!sourceExtraFile)throw new Error('restore-source-observation-required');
  const sourceRaw=sourceExtraFile?await ownedBytes(sourceExtraFile,2*1024*1024):extraRaw;
  if(json(parseItemStateObservation(sourceRaw))!==json(expected.before))throw new Error('enabled-proof-current-source-mismatch');
  const backupParent=path.dirname(backupFile),backupDir=await fs.lstat(backupParent);if(!backupDir.isDirectory()||backupDir.mode&0o077||backupDir.uid!==process.getuid()||await fs.realpath(backupParent)!==backupParent)throw new Error('unsafe-enabled-proof-backup-directory');
  const initialBackup=await ownedBytes(backupFile,24*1024*1024);if(sha(initialBackup)!==expectedBackupSha256)throw new Error('enabled-proof-backup-changed');
  await ownedBytes(backupFile,24*1024*1024,true);
  const backup=await inspectResolveProjectExport(backupFile,expectedBackupSha256),backupRaw=await ownedBytes(backupFile,24*1024*1024);if(sha(backupRaw)!==backup.sha256)throw new Error('enabled-proof-backup-changed');
  const record=await prepareItemStateMenu({baselineFile:baselineRichFile,install:false});record.operation='prepare-item-enabled-proof';record.mode=mode;record.backup=backup;
  Object.assign(record.paths,{baselineExtra:path.join(record.directory,'baseline-extra.json'),baselineRich:path.join(record.directory,'baseline-rich.json'),sourceExtra:path.join(record.directory,'source-extra.json'),backup:path.join(record.directory,'baseline.drp'),afterBackup:path.join(record.directory,'post-state.drp'),ready:path.join(record.directory,'ready.json'),started:path.join(record.directory,'started.json'),richResult:path.join(record.directory,'rich-result.json')});
  record.baselineExtraSha256=sha(extraRaw);record.baselineRichSha256=sha(richRaw);record.sourceExtraSha256=sha(sourceRaw);
  record.readyBytes=JSON.stringify({schemaVersion:1,operation:'item-enabled-ready',id:record.id,mode})+'\n';record.startedBytes=JSON.stringify({schemaVersion:1,operation:'item-enabled-started',id:record.id,mode});
  for(const[name,bytes]of [['baselineExtra',extraRaw],['baselineRich',richRaw],['sourceExtra',sourceRaw],['backup',backupRaw],['ready',record.readyBytes]])await fs.writeFile(record.paths[name],bytes,{flag:'wx',mode:0o600});
  record.sourcePath=path.join(record.directory,basename(record.id));record.installedPath=install?path.join(utility,basename(record.id)):null;
  const source=renderItemEnabledProof(await getSources(),record,extra,rich);record.sourceSha256=sha(source);await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
  if(install){const info=await fs.lstat(utility);if(!info.isDirectory()||await fs.realpath(utility)!==utility||info.uid!==process.getuid())throw new Error('unsafe-enabled-proof-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
  record.preparationFile=path.join(record.directory,'enabled-preparation.json');await fs.writeFile(record.preparationFile,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});return record;
}
async function readItemEnabledProof(preparationFile){
  const record=JSON.parse(await ownedBytes(preparationFile,16384)),directory=path.dirname(path.resolve(preparationFile));
  if(record.schemaVersion!==1||record.operation!=='prepare-item-enabled-proof'||!/^[a-f0-9]{32}$/.test(record.id||'')||!['disable','restore'].includes(record.mode)||record.directory!==directory||record.projectId!==projectId||record.projectName!==projectName||record.sourcePath!==path.join(directory,basename(record.id)))throw new Error('invalid-enabled-proof-record');
  const dir=await fs.lstat(directory);if(!dir.isDirectory()||dir.mode&0o077||dir.uid!==process.getuid()||await fs.realpath(directory)!==directory)throw new Error('unsafe-enabled-proof-directory');
  const names={result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json',baseline:'baseline-observation.json',baselineExtra:'baseline-extra.json',baselineRich:'baseline-rich.json',sourceExtra:'source-extra.json',backup:'baseline.drp',afterBackup:'post-state.drp',ready:'ready.json',started:'started.json',richResult:'rich-result.json'};
  for(const[name,file]of Object.entries(names))if(record.paths[name]!==path.join(directory,file))throw new Error('enabled-proof-path-mismatch');
  const extraRaw=await ownedBytes(record.paths.baselineExtra,2*1024*1024),richRaw=await ownedBytes(record.paths.baselineRich,2*1024*1024),currentRaw=await ownedBytes(record.paths.sourceExtra,2*1024*1024);
  if(sha(extraRaw)!==record.baselineExtraSha256||sha(richRaw)!==record.baselineRichSha256||sha(currentRaw)!==record.sourceExtraSha256)throw new Error('enabled-proof-source-changed');
  const extra=parseItemStateObservation(extraRaw),rich=parseEffectObservation(richRaw),expected=states(extra,rich,record.mode);if(json(parseItemStateObservation(currentRaw))!==json(expected.before))throw new Error('enabled-proof-current-source-mismatch');
  const sources=await getSources();if(json(record.sourceHashes)!==json(Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(v)]))))throw new Error('enabled-proof-program-changed');
  const source=await ownedBytes(record.sourcePath,512*1024);if(sha(source)!==record.sourceSha256||!source.equals(Buffer.from(renderItemEnabledProof(sources,record,extra,rich))))throw new Error('enabled-proof-program-changed');
  const backupSha256=record.backup.sha256;if(!/^[a-f0-9]{64}$/.test(backupSha256||'')||record.backup.archiveVerified!==true||sha(await ownedBytes(record.paths.backup,24*1024*1024))!==backupSha256)throw new Error('enabled-proof-backup-changed');
  if(record.readyBytes!==JSON.stringify({schemaVersion:1,operation:'item-enabled-ready',id:record.id,mode:record.mode})+'\n'||record.startedBytes!==JSON.stringify({schemaVersion:1,operation:'item-enabled-started',id:record.id,mode:record.mode}))throw new Error('enabled-proof-barrier-record-changed');
  if((await ownedBytes(record.paths.ready,4096)).toString('utf8')!==record.readyBytes)throw new Error('enabled-proof-ready-changed');
  try{const failure=JSON.parse(await ownedBytes(record.paths.failure,4096,true));if(Object.keys(failure).sort().join(',')!=='errorCode,experimental,mutationAttempted,operation,readOnly,requestId,safeToApply,schemaVersion,stage'||failure.schemaVersion!==1||failure.operation!=='resolve-item-enabled-proof-failure'||failure.requestId!==record.id||failure.readOnly!==false||failure.experimental!==true||failure.safeToApply!==false||typeof failure.mutationAttempted!=='boolean'||!['guard','capture','clip-enabled-write','save-reopen','validation','post-state-export','observation-write','result-write','marker-write'].includes(failure.stage)||!['capture-failed','operation-failed','output-failed','unsupported-field','invalid-value','oversize','state-changed','expected-snapshot-diverged','item-state-diverged','page-context-diverged','snapshot-context-diverged','timeline-context-diverged','membership-diverged'].includes(failure.errorCode))throw new Error('invalid-enabled-proof-failure');return{status:failure.mutationAttempted?'recovery-required':'preflight-rejected',safeToApply:false,experimental:true,mode:record.mode,backupSha256,...failure};}catch(error){if(error.code!=='ENOENT')throw error;}
  if((await ownedBytes(record.paths.started,4096,true)).toString('utf8')!==record.startedBytes+'\n')throw new Error('enabled-proof-start-not-verified');
  const result=JSON.parse(await ownedBytes(record.paths.result,4096,true)),raw=await ownedBytes(record.paths.observation,2*1024*1024,true),observed=parseItemStateObservation(raw),afterRich=parseEffectObservation(await ownedBytes(record.paths.richResult,2*1024*1024,true));
  if(Object.keys(result).sort().join(',')!=='enabled,experimental,itemCount,mode,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion,targetItemId'||result.schemaVersion!==1||result.operation!=='resolve-item-enabled-proof'||result.requestId!==record.id||result.mode!==record.mode||result.targetItemId!==targetItemId||result.projectId!==projectId||result.readOnly!==false||result.experimental!==true||result.safeToApply!==false||result.enabled!==expected.resultEnabled||result.itemCount!==50||result.observationBytes!==raw.length-1||json(observed)!==json(expected.after)||json(afterRich)!==json(expected.rich)||(await ownedBytes(record.paths.marker,256,true)).toString('utf8')!==`FRAMELINE_ITEM_ENABLED_PROOF_COMPLETE_V1:${record.id}\n`)throw new Error('enabled-proof-result-mismatch');
  await ownedBytes(record.paths.afterBackup,24*1024*1024,true);const postStateBackup=await inspectResolveProjectExport(record.paths.afterBackup);
  return{status:record.mode==='disable'?'disabled':'restored',schemaVersion:1,experimental:true,safeToApply:false,mode:record.mode,targetItemId,enabled:result.enabled,backupSha256,postStateBackup,sourceSha256:record.sourceSha256,observationSha256:sha(raw),richObservationSha256:sha(await ownedBytes(record.paths.richResult,2*1024*1024)),itemCount:50,observation:observed,richObservation:afterRich,
    limitations:['This is a pinned disposable experiment, not ordinary Apply or complete editor-state validation.','Archive content hash is verified by the host; the runtime checks only retained backup presence and size.','A failed started operation retains the backup and requires fresh inspection before a separately prepared restoration.']};
}
if(require.main===module){const[op,...args]=process.argv.slice(2);let task;if(op==='prepare')task=prepareItemEnabledProof({mode:args[0],baselineExtraFile:args[1],baselineRichFile:args[2],backupFile:args[3],expectedBackupSha256:args[4],sourceExtraFile:args[5]&&args[5]!=='--install'?args[5]:null,install:args.includes('--install')});else if(op==='read'&&args.length===1)task=readItemEnabledProof(args[0]).then(({observation,richObservation,...summary})=>summary);else task=Promise.reject(new Error('usage'));task.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(()=>{process.stderr.write('item-enabled-proof-failed\n');process.exitCode=1;});}
module.exports={prepareItemEnabledProof,readItemEnabledProof,renderItemEnabledProof,states,targetItemId};
