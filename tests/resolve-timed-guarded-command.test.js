'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const sync=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const{spawnSync}=require('node:child_process');
const{prepareRenameTrial,issueRenameTrial,recordRenameTrialFileResult}=require('../src/resolve-rename-trial');
const{prepareTimedCommand,readTimedResult,inspectInputs,quantizationWindow}=require('../phase-0/prepare-timed-guarded-command');
const{executeCommand,library}=require('./fixtures/resolve-editor-mock/execute-command');
const skip=!sync.existsSync(library)&&'Vendor Lua unavailable';
const json=JSON.stringify;
function observation(){return{schemaVersion:2,operation:'resolve-effect-observation',readOnly:true,safeToApply:false,
  snapshot:{schema_version:3,resolve_version:'21.1.2.10',project_id:'project-id',project_name:'Frameline Timed Mock',timelines:[{id:'timeline-id',name:'Timeline',start_frame:0,
    tracks:[{type:'video',index:1,name:'Video'},{type:'audio',index:1,name:'Empty audio'}],items:[{id:'item-id',track_type:'video',track_index:1,type:'video',name:'Clip',start_frame:0,end_frame:24,source_start_frame:0,source_end_frame:24,media_pool_id:'media-id',linked_item_ids:[],effect_counts:{fusion:0,ofx:0,audio:0}}]}]},
  activeTimelineId:'timeline-id',items:[{timelineId:'timeline-id',itemId:'item-id',effects:[],propertyReadStatus:'captured',properties:{Pan:{decimal:'0.0000000000000000e+00'},TransformEnabled:true}}],
  tracks:[{timelineId:'timeline-id',type:'video',index:1,enabled:true,locked:false},{timelineId:'timeline-id',type:'audio',index:1,enabled:true,locked:false}]};}
async function setup(t,{forced=false,issued=true}={}){
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'timed-trial-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const before=observation(),after=structuredClone(before);after.snapshot.timelines[0].items[0].name='Reviewed rename';
  const trial=await prepareRenameTrial({beforeBytes:json(before.snapshot),afterBytes:json(after.snapshot),destinationDir:root,disposableProjectName:before.snapshot.project_name,effectObservationBytes:json(before)});
  let emitted=trial;
  if(issued){for(const name of['project.xml','MediaPool/Master/MpFolder.xml','SeqContainer/test.xml']){const file=path.join(trial.directory,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'<Fixture/>');}
    assert.equal(spawnSync('zip',['-q',trial.backupPath,'project.xml','MediaPool/Master/MpFolder.xml','SeqContainer/test.xml'],{cwd:trial.directory}).status,0);
    emitted=await issueRenameTrial({directory:trial.directory,forceFailure:forced,resultTransport:'retained-file'});}
  const emittedFile=path.join(root,'emitted.json');await fs.writeFile(emittedFile,json(emitted),{mode:0o600});
  const prepared=await prepareTimedCommand({emittedFile,trialDirectory:trial.directory,stage:issued?'issued':'backup'});
  t.after(()=>fs.rm(prepared.directory,{recursive:true,force:true}));
  return{before,after,trial,emitted,emittedFile,prepared,preparation:path.join(prepared.directory,'preparation.json'),source:await fs.readFile(prepared.preparedPath,'utf8')};
}

test('unchanged issued command timing preserves applied retained result and exact underlying API behavior',{skip},async t=>{
  const f=await setup(t);const run=executeCommand(f.source,f.before);assert.equal(run.ok,true,run.error);assert.deepEqual(run.saved,f.after);
  const report=await readTimedResult(f.preparation);assert.equal(report.commandReturnedNormally,true);assert.equal(report.safeToApply,false);
  assert.deepEqual(report.calls.map(c=>c.method),['item.SetName','manager.SaveProject','manager.CloseProject','manager.LoadProject']);
  assert(report.calls.every(c=>c.wallNs>=0&&c.cpuMicros>=0));
  const recorded=await recordRenameTrialFileResult({directory:f.trial.directory});assert.equal(recorded.status,'applied');
  const replay=executeCommand(f.source,f.before);assert.equal(replay.counters.setName,0);
});

test('forced rollback timing records both independent save/reopen cycles and exact original state',{skip},async t=>{
  const f=await setup(t,{forced:true});const run=executeCommand(f.source,f.before);assert.deepEqual(run.saved,f.before);
  const report=await readTimedResult(f.preparation);assert.equal(report.calls.length,8);
  assert.equal(report.calls.filter(call=>call.method==='item.SetName').length,2);
  assert.equal((await recordRenameTrialFileResult({directory:f.trial.directory})).status,'rolled-back');
});

test('source divergence remains rejected before rename while a timing report is not a successful trial outcome',{skip},async t=>{
  const f=await setup(t);const changed=structuredClone(f.before);changed.items[0].properties.Pan.decimal='1.0000000000000000e+00';
  const run=executeCommand(f.source,changed);assert.equal(run.counters.setName,0);assert.deepEqual(run.saved,changed);
  const report=await readTimedResult(f.preparation);assert.equal(report.commandReturnedNormally,false);assert.equal(report.failureCode,'guarded-command-failed');assert.deepEqual(report.calls,[]);
  await assert.rejects(recordRenameTrialFileResult({directory:f.trial.directory}));
});

test('backup timings preserve the unchanged guarded save/export command',{skip},async t=>{
  const f=await setup(t,{issued:false});
  const prefix="local pm=resolve:GetProjectManager();function pm:ExportProject(name,filename,flag)return true end;";
  const run=executeCommand(prefix+f.source,f.before);assert.deepEqual(run.saved,f.before);
  const report=await readTimedResult(f.preparation);assert.deepEqual(report.calls.map(c=>c.method),['manager.SaveProject','manager.ExportProject']);
});

test('host refuses changed issued input and output hardlinks without chmoding unrelated files',{skip},async t=>{
  const f=await setup(t);executeCommand(f.source,f.before);
  const original=await fs.readFile(f.emittedFile);await fs.appendFile(f.emittedFile,' ');await assert.rejects(readTimedResult(f.preparation),/timing-source-changed/);await fs.writeFile(f.emittedFile,original);
  const outside=path.join(f.prepared.directory,'unrelated');await fs.writeFile(outside,'unrelated',{mode:0o644});await fs.unlink(f.prepared.resultPath);await fs.link(outside,f.prepared.resultPath);
  await assert.rejects(readTimedResult(f.preparation),/invalid-timing-output/);assert.equal((await fs.stat(outside)).mode&0o777,0o644);
});

test('timing reader rejects a forged parent alias before tightening outside outputs',async t=>{
  const f=await setup(t);const holder=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'timing-alias-test-'));t.after(()=>fs.rm(holder,{recursive:true,force:true}));
  const alias=path.join(holder,'alias');await fs.symlink(path.dirname(f.prepared.directory),alias);
  const forged=path.join(alias,path.basename(f.prepared.directory));
  const record=JSON.parse(JSON.stringify(f.prepared).replaceAll(f.prepared.directory,forged));
  const prep=path.join(forged,'forged-preparation.json');await fs.writeFile(prep,JSON.stringify(record));
  await fs.writeFile(f.prepared.resultPath,'outside owned output',{mode:0o644});
  await assert.rejects(readTimedResult(prep),/invalid-timing-directory/);
  assert.equal((await fs.stat(f.prepared.resultPath)).mode&0o777,0o644);
});

test('timed inputs require rich complete represented guards and a retained verified issuance',async t=>{
  const f=await setup(t);const plan=await fs.readFile(path.join(f.trial.directory,'prepared.json'));
  const legacy=JSON.parse(plan);delete legacy.effectGuard;
  assert.throws(()=>inspectInputs(json(f.emitted),json(legacy),'issued'),/invalid-timed-command-input/);
  assert.throws(()=>inspectInputs(json({...f.emitted,resultTransport:'console'}),plan,'issued'),/retained-verified-trial-required/);
  assert.throws(()=>inspectInputs(json(f.emitted),plan,'other'),/invalid-timed-command-stage/);
});

test('coarse timing windows do not mistake zero ticks for zero elapsed duration',()=>{
  const clock={id:'lua-os-time'};
  const zero=quantizationWindow({wallStatus:'captured',wallNs:0},clock);assert.equal(zero.lowerNs,0);assert.equal(zero.upperExclusiveNs,1000000000);assert.equal(zero.zeroTicksMeansBelowOneSecond,true);
  const two=quantizationWindow({wallStatus:'captured',wallNs:2000000000},clock);assert.equal(two.lowerNs,1000000000);assert.equal(two.upperExclusiveNs,3000000000);
  assert.equal(quantizationWindow({wallStatus:'unavailable-or-regressed'},clock),null);
});

test('native backup timing retains actual coarse samples and independently verified archive evidence',()=>{
  const{createHash}=require('node:crypto');const hash=b=>createHash('sha256').update(b).digest('hex');
  const record=require('../phase-0/resolve-operation-backup-live-observation.json');
  const bytes=sync.readFileSync(path.join(__dirname,'../phase-0/resolve-operation-backup-live-result.json'));
  assert.equal(hash(bytes),record.resultSha256);const result=JSON.parse(bytes);
  assert.equal(result.stage,'backup');assert.equal(result.commandReturnedNormally,true);assert.equal(result.representedItemCount,50);
  assert.deepEqual(result.calls.map(call=>call.method),['manager.SaveProject','manager.ExportProject']);
  assert(result.calls.every(call=>call.firstReturnBoolean===true));assert.equal(result.wallClock.id,'lua-os-time');
  assert.equal(record.nativeBackup.archiveVerified,true);assert.equal(record.nativeBackup.mode,0o600);assert.equal(record.nativeBackup.size,53560);
  assert.equal(record.result.coarseWallWindows.calls[0].window.upperExclusiveNs,1000000000);
  assert.equal(record.result.coarseWallWindows.calls[1].window.upperExclusiveNs,2000000000);
  assert.equal(record.safeToApply,false);assert.equal(record.ordinaryApplyEnabled,false);
  for(const[file,expected]of [[record.templateSource,record.templateSha256],[record.clockSource,record.clockSourceSha256],[record.baseSource,record.baseSourceSha256],[record.guardedCommandGenerator,record.guardedCommandGeneratorSha256]])assert.equal(hash(sync.readFileSync(path.join(__dirname,'..',file))),expected);
});

test('native rename/rollback timing recomputes portable outcome, exact represented restoration and sampled RSS',()=>{
  const{createHash}=require('node:crypto');const{gunzipSync}=require('node:zlib');
  const{validatePortableTrialAudit}=require('../src/resolve-portable-trial-audit');
  const{parseEffectObservation}=require('../src/resolve-effect-observation');
  const hash=b=>createHash('sha256').update(b).digest('hex'),root=path.join(__dirname,'..');
  const record=require('../phase-0/resolve-operation-rename-live-observation.json');
  const bytes=sync.readFileSync(path.join(root,record.resultFile));assert.equal(hash(bytes),record.resultSha256);
  const result=JSON.parse(bytes);assert.equal(result.stage,'issued');assert.equal(result.calls.length,8);
  assert.deepEqual(result.calls.map(call=>call.method),['item.SetName','manager.SaveProject','manager.CloseProject','manager.LoadProject','item.SetName','manager.SaveProject','manager.CloseProject','manager.LoadProject']);
  assert.equal(result.total.cpuMicros,2349874);assert.equal(result.total.wallNs,3000000000);
  assert.equal(record.result.coarseWallWindows.total.lowerNs,2000000000);assert.equal(record.result.coarseWallWindows.total.upperExclusiveNs,4000000000);
  const auditCompressed=sync.readFileSync(path.join(root,record.portableAudit.file));assert.equal(hash(auditCompressed),record.portableAudit.compressedSha256);
  const auditBytes=gunzipSync(auditCompressed,{maxOutputLength:1024*1024});assert.equal(hash(auditBytes),record.portableAudit.rawSha256);
  const audit=validatePortableTrialAudit(JSON.parse(auditBytes));assert.equal(audit.outcome.status,'rolled-back');assert.equal(audit.transactionId,result.transactionId);
  assert.equal(hash(Buffer.from(audit.resultSnapshot)),record.independentTrial.resultingSnapshotSha256);
  assert.equal(hash(Buffer.from(audit.sources.local)),record.independentTrial.sourceSha256);
  const compressed=sync.readFileSync(path.join(root,record.baselineObservation.file));assert.equal(hash(compressed),record.baselineObservation.compressedSha256);
  const baseline=gunzipSync(compressed,{maxOutputLength:1024*1024});assert.equal(hash(baseline),record.baselineObservation.rawSha256);
  const observation=parseEffectObservation(baseline);assert.equal(baseline.toString('utf8'),audit.effects.after);assert.equal(audit.effects.before,audit.effects.after);
  assert.equal(observation.items.length,50);assert.equal(observation.tracks.length,5);
  assert.equal(observation.items.reduce((n,item)=>n+Object.keys(item.properties).length,0),1600);
  const rssBytes=sync.readFileSync(path.join(root,record.resources.file));assert.equal(hash(rssBytes),record.resources.sha256);const rss=JSON.parse(rssBytes);
  assert.equal(rss.status,'completion-marker-observed');assert.equal(rss.samples.length,84);
  assert.equal(rss.maximumObservedKiB,Math.max(...rss.samples.map(sample=>sample.rssKiB)));assert.equal(rss.firstKiB,rss.samples[0].rssKiB);assert.equal(rss.lastKiB,rss.samples.at(-1).rssKiB);
  assert(rss.samples.every((sample,index)=>Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0&&Number.isSafeInteger(sample.rssKiB)&&sample.rssKiB>=0&&(!index||sample.elapsedMs>=rss.samples[index-1].elapsedMs)));
  assert.equal(record.representedRestoration.completeNativePreservationProven,false);assert.equal(record.ordinaryApplyEnabled,false);
});
