'use strict';
// Diagnostic only: two typed reads are retained even when they differ.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { prepareItemStateMenu, getSources, renderItemStateMenu, ownedBytes, projectName, projectId } = require('./prepare-item-state-menu');
const { parseEffectObservation, validateEffectObservation } = require('../src/resolve-effect-observation');
const { propertyCaptureConfig } = require('../src/resolve-property-observation');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { validateItemStateReading, compareItemStateReadings } = require('../src/resolve-item-state-observation');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const same = (a,b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const basename = id => `Frameline Item State Diagnostic ${id.slice(0,12)}.lua`;
const utility = path.join(os.homedir(),'Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility');

function renderItemStateDiagnostic(sources, record, baseline) {
  const stateKey='src/companion/resolve-item-state.lua', templateKey='phase-0/resolve-item-state-menu.lua';
  const sentinel='return {capture = capture}';
  if(sources[stateKey].split(sentinel).length!==2)throw new Error('incompatible-item-state-diagnostic');
  const copied={...sources,[stateKey]:sources[stateKey].replace(sentinel,'return {capture=capture,read_once=read_once,current_page=current_page}')};
  const start="  stage = 'capture'", end='  local bytes = encode(observed)';
  const a=copied[templateKey].indexOf(start),b=copied[templateKey].indexOf(end,a);
  if(a<0||b<0)throw new Error('incompatible-item-state-diagnostic-template');
  const diagnostic=String.raw`  stage = 'capture'
  local p=resolve:GetProjectManager():GetCurrentProject()
  assert(p:GetTimelineCount()==1,'Unexpected diagnostic timelines')
  local t=p:GetTimelineByIndex(1);local tracks,items=0,0
  for _,kind in ipairs({'video','audio','subtitle'})do local n=t:GetTrackCount(kind);assert(type(n)=='number'and n>=0 and n<=5 and n%1==0,'Unexpected diagnostic tracks');tracks=tracks+n;for index=1,n do local list=t:GetItemListInTrack(kind,index)or{};items=items+#list;assert(items<=50,'Diagnostic item bound exceeded')end end
  assert(tracks==5 and items==50,'Unexpected diagnostic fixture shape')
  local function active()local t=p:GetCurrentTimeline();return t and t:GetUniqueId()or base.null end
  local rich_before=effects.capture(resolve,base,PROPERTY_CONFIG)
  local page_before=state.current_page(resolve)
  local first={snapshot=rich_before.snapshot,activeTimelineId=active(),capturePage=page_before,colorGraphScope='first-layer-count-only',colorGraphReadPolicy='color-page-only',items=state.read_once(resolve,base,page_before)}
  local between=base.capture(resolve)
  local page_between=state.current_page(resolve)
  local second={snapshot=between,activeTimelineId=active(),capturePage=page_between,colorGraphScope='first-layer-count-only',colorGraphReadPolicy='color-page-only',items=state.read_once(resolve,base,page_between)}
  local rich_after=effects.capture(resolve,base,PROPERTY_CONFIG)
  local observed={schemaVersion=1,operation='resolve-item-state-diagnostic',requestId=request_id,readOnly=true,safeToApply=false,stableObservationAccepted=false,
    first=first,second=second,afterSnapshot=rich_after.snapshot,richBefore=rich_before,richAfter=rich_after,capturePageAfter=state.current_page(resolve),activeTimelineAfter=active(),
    expectedSnapshotMatchesAtStart=expected_snapshot==nil or base.encode(first.snapshot)==base.encode(expected_snapshot)}
  local bytes = encode(observed)`;
  copied[templateKey]=copied[templateKey].slice(0,a)+diagnostic.replaceAll('PROPERTY_CONFIG',propertyCaptureConfig())+copied[templateKey].slice(b+end.length);
  copied[templateKey]=copied[templateKey].replace("operation = 'resolve-item-state-menu'","operation = 'resolve-item-state-diagnostic-menu'")
    .replace('itemCount = #observed.items','itemCount = #observed.first.items')
    .replaceAll('FRAMELINE_ITEM_STATE_MENU_','FRAMELINE_ITEM_STATE_DIAGNOSTIC_')
    .replace("operation = 'resolve-item-state-menu-failure'","operation = 'resolve-item-state-diagnostic-failure'");
  return renderItemStateMenu(copied,record,baseline);
}
async function prepareItemStateDiagnostic({baselineFile,install=false}={}) {
  if(typeof baselineFile!=='string'||!path.isAbsolute(baselineFile))throw new Error('diagnostic-baseline-required');
  const record=await prepareItemStateMenu({baselineFile,install:false}),sources=await getSources();
  record.operation='prepare-item-state-diagnostic';record.sourcePath=path.join(record.directory,basename(record.id));
  record.installedPath=install?path.join(utility,basename(record.id)):null;
  const baseline=parseEffectObservation(await ownedBytes(record.paths.baseline,2*1024*1024));
  const source=renderItemStateDiagnostic(sources,record,baseline.snapshot);record.sourceSha256=sha(source);
  await fs.writeFile(record.sourcePath,source,{flag:'wx',mode:0o600});
  if(install){const info=await fs.lstat(utility);if(!info.isDirectory()||await fs.realpath(utility)!==utility||info.uid!==process.getuid())throw new Error('unsafe-diagnostic-install');await fs.writeFile(record.installedPath,source,{flag:'wx',mode:0o600});}
  const preparationFile=path.join(record.directory,'diagnostic-preparation.json');
  await fs.writeFile(preparationFile,JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return {...record,preparationFile};
}
function validateDiagnostic(value,id) {
  function plain(input,depth=0){if(input===null||typeof input!=='object')return;if(depth>40||![Object.prototype,null,Array.prototype].includes(Object.getPrototypeOf(input)))throw new Error('invalid-item-state-diagnostic');for(const name of Reflect.ownKeys(input)){const d=Object.getOwnPropertyDescriptor(input,name);if(typeof name!=='string'||!d||!Object.hasOwn(d,'value')||!d.enumerable&&name!=='length')throw new Error('invalid-item-state-diagnostic');plain(d.value,depth+1);}}
  plain(value);
  const keys=['schemaVersion','operation','requestId','readOnly','safeToApply','stableObservationAccepted','first','second','afterSnapshot','richBefore','richAfter','capturePageAfter','activeTimelineAfter','expectedSnapshotMatchesAtStart'];
  if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||value.schemaVersion!==1||value.operation!=='resolve-item-state-diagnostic'
    ||value.requestId!==id||value.readOnly!==true||value.safeToApply!==false||value.stableObservationAccepted!==false||typeof value.expectedSnapshotMatchesAtStart!=='boolean')throw new Error('invalid-item-state-diagnostic');
  validateItemStateReading(value.first);validateItemStateReading(value.second);validateResolveSnapshot(value.afterSnapshot);validateEffectObservation(value.richBefore);validateEffectObservation(value.richAfter);
  for(const snapshot of [value.first.snapshot,value.second.snapshot,value.afterSnapshot,value.richBefore.snapshot,value.richAfter.snapshot]){
    if(snapshot.project_id!==projectId||snapshot.project_name!==projectName||snapshot.timelines.length!==1||snapshot.timelines[0].items.length!==50||snapshot.timelines[0].tracks.length!==5)throw new Error('diagnostic-fixture-mismatch');
  }
  if(!same(value.first.snapshot,value.richBefore.snapshot)||!same(value.afterSnapshot,value.richAfter.snapshot)
    ||![null,'media','photo','cut','edit','fusion','color','fairlight','deliver'].includes(value.capturePageAfter)
    ||value.activeTimelineAfter!==null&&!value.afterSnapshot.timelines.some(t=>t.id===value.activeTimelineAfter))throw new Error('diagnostic-context-invalid');
  return value;
}
async function readItemStateDiagnostic(preparationFile) {
  const record=JSON.parse(await ownedBytes(preparationFile,8192)),directory=path.dirname(path.resolve(preparationFile));
  if(record.schemaVersion!==1||record.operation!=='prepare-item-state-diagnostic'||!/^[a-f0-9]{32}$/.test(record.id||'')||record.directory!==directory
    ||record.projectName!==projectName||record.projectId!==projectId||record.sourcePath!==path.join(directory,basename(record.id)))throw new Error('invalid-diagnostic-record');
  const info=await fs.lstat(directory);if(!info.isDirectory()||info.mode&0o077||info.uid!==process.getuid()||await fs.realpath(directory)!==directory)throw new Error('unsafe-diagnostic-directory');
  for(const [name,file]of Object.entries({result:'result.json',observation:'observation.json',marker:'complete.txt',failure:'failure.json',baseline:'baseline-observation.json'}))if(record.paths[name]!==path.join(directory,file))throw new Error('diagnostic-path-mismatch');
  const sources=await getSources();if(!same(record.sourceHashes,Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,sha(v)]))))throw new Error('diagnostic-source-changed');
  const baselineRaw=await ownedBytes(record.paths.baseline,2*1024*1024);if(sha(baselineRaw)!==record.baselineSha256)throw new Error('diagnostic-baseline-changed');
  const baseline=parseEffectObservation(baselineRaw),source=await ownedBytes(record.sourcePath,128*1024);
  if(sha(source)!==record.sourceSha256||!source.equals(Buffer.from(renderItemStateDiagnostic(sources,record,baseline.snapshot))))throw new Error('diagnostic-source-changed');
  const raw=await ownedBytes(record.paths.observation,2*1024*1024,true),value=validateDiagnostic(JSON.parse(raw),record.id);
  const result=JSON.parse(await ownedBytes(record.paths.result,4096,true)),marker=await ownedBytes(record.paths.marker,256,true);
  if(Object.keys(result).sort().join(',')!=='itemCount,observationBytes,operation,projectId,readOnly,requestId,safeToApply,schemaVersion'||result.schemaVersion!==1
    ||result.operation!=='resolve-item-state-diagnostic-menu'||result.projectId!==projectId||result.requestId!==record.id||result.itemCount!==50||result.observationBytes!==raw.length-1||result.readOnly!==true||result.safeToApply!==false
    ||marker.toString('utf8')!==`FRAMELINE_ITEM_STATE_DIAGNOSTIC_COMPLETE_V1:${record.id}\n`)throw new Error('diagnostic-incomplete');
  const compared=compareItemStateReadings(value.first,value.second);
  return {schemaVersion:1,status:'diagnostic-complete',readOnly:true,safeToApply:false,stableObservationAccepted:false,requestId:record.id,
    observationSha256:sha(raw),sourceSha256:record.sourceSha256,sourceHashes:record.sourceHashes,
    itemCount:50,itemStateChanges:compared.itemStateChanges,snapshotChanges:compared.snapshotChanges,capturePageChange:compared.capturePageChange,
    activeTimelineChange:compared.activeTimelineChange,capturePageAfter:value.capturePageAfter,
    richBeforeMatchesBaseline:same(value.richBefore,baseline),richAfterMatchesBaseline:same(value.richAfter,baseline),
    afterSnapshotMatchesBefore:same(value.afterSnapshot,value.first.snapshot),expectedSnapshotMatchesAtStart:value.expectedSnapshotMatchesAtStart,
    projectMutationApiCalls:0,diagnostic:value,
    limitations:['This retains divergent reads for diagnosis; it is not an accepted stable observation.','Getter calls can have UI side effects; no project write API is invoked.']};
}
if(require.main===module){const[op,...args]=process.argv.slice(2);const task=op==='prepare'?prepareItemStateDiagnostic({baselineFile:args.find(v=>v!=='--install'),install:args.includes('--install')}):['read','raw'].includes(op)&&args.length===1?readItemStateDiagnostic(args[0]).then(result=>{if(op==='raw')return result.diagnostic;const{diagnostic,...summary}=result;return summary;}):Promise.reject(new Error('usage'));task.then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(()=>{process.stderr.write('item-state-diagnostic-failed\n');process.exitCode=1;});}
module.exports={prepareItemStateDiagnostic,readItemStateDiagnostic,renderItemStateDiagnostic,validateDiagnostic};
