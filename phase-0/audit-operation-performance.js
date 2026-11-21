'use strict';
// Recompute one bounded personal-fixture measurement proof. No editor access.
const path=require('node:path');
const{createHash}=require('node:crypto');
const{gunzipSync}=require('node:zlib');
const{readInput}=require('./integration-input');
const{validateClockResult,validateClockDescription}=require('./prepare-operation-clock-probe');
const{quantizationWindow}=require('./prepare-timed-guarded-command');
const{validatePortableTrialAudit}=require('../src/resolve-portable-trial-audit');
const{parseEffectObservation,compareEffectObservations}=require('../src/resolve-effect-observation');
const{scanXml}=require('../src/fcpxml-adapter');
const root=path.resolve(__dirname,'..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const requireProof=condition=>{if(!condition)throw new Error('operation-performance-evidence-invalid');};
const pins={
  'phase-0/resolve-operation-clock-live-result.json':'2d1875a0271dd984861cb04a9e3d05853f68519f1d344e1239d4b3e5c5f6a141',
  'phase-0/resolve-operation-backup-live-result.json':'d82994fcf03f52c7faf50b5f9366950075a52f57314bfa2b779c19dfa2cbe408',
  'phase-0/resolve-operation-rename-live-result.json':'513550cf6c94c42190b06195fb37b076315c1d7ffc0acce255385c0306638907',
  'phase-0/resolve-operation-rename-rss.json':'b39de995870a15987c90f9a8c2600c9b57068371d61f85967ead9bc6bfdd4a03',
  'phase-0/resolve-operation-scan-live-observation.json':'d4ce32af743c1b4eb5ca7bd2f44d97a6118c88f2231c69c16fc25cd6652d59ec',
  'phase-0/evidence-sources/resolve-operation-scan-observed-20261120.json.txt':'3fe73a29923b3ce4c2e067e937d68bb00ccd9e3b8d3df1a844d8bba2f5b83416'
};
const rawAuditSha='032e6d020caac7555efa3ad149d43eaadbf6f85ec35a10da5bc7b06f3969ddd2';
const rawBaselineSha='e171ed4dd9ff1d346a80c0e566d810a947ec360292036d7e3fca0403e2d0f1af';
const sourceXmlSha='c95d98f5debbf247df581fdf29d55ad514abd971bd76dfd0b49bcc53a052cc1c';

function auditOperationPerformance(read=file=>readInput(path.join(root,file))){
  try{
    const sources={};
    function bytes(file){const value=read(file);requireProof(Buffer.isBuffer(value));sources[file]=sha(value);if(pins[file])requireProof(sources[file]===pins[file]);return value;}
    const json=file=>JSON.parse(bytes(file));
    function unpack(file,expectedRaw,expectedCompressed){const stored=bytes(file);requireProof(sha(stored)===expectedCompressed);const raw=gunzipSync(stored,{maxOutputLength:2*1024*1024});requireProof(sha(raw)===expectedRaw);return raw;}
    const clock=validateClockResult(json('phase-0/resolve-operation-clock-live-result.json'));
    const backup=json('phase-0/resolve-operation-backup-live-result.json'),issued=json('phase-0/resolve-operation-rename-live-result.json');
    const backupRecord=json('phase-0/resolve-operation-backup-live-observation.json'),issuedRecord=json('phase-0/resolve-operation-rename-live-observation.json');
    for(const [raw,record,expectedFile]of [[backup,backupRecord,'phase-0/resolve-operation-backup-live-result.json'],[issued,issuedRecord,'phase-0/resolve-operation-rename-live-result.json']]){
      requireProof(raw.schemaVersion===1&&raw.operation==='resolve-timed-guarded-command'&&raw.experimental===true&&raw.safeToApply===false&&raw.commandReturnedNormally===true&&raw.failureCode==='none');
      requireProof(record.safeToApply===false&&record.ordinaryApplyEnabled===false&&record.installedScriptRemoved===true&&record.existingGuardedCommandEmbeddedUnchanged===true&&record.completionMarkerVerified===true);
      requireProof(same(raw,Object.fromEntries(Object.keys(raw).map(key=>[key,record.result[key]]))));
      validateClockDescription(raw.wallClock);requireProof(same(raw.wallClock,clock.wallClock));
      requireProof(record.resultFile===expectedFile&&record.resultSha256===pins[expectedFile]&&raw.commandSha256===record.commandSha256&&raw.projectId===issued.projectId&&raw.transactionId===issued.transactionId&&raw.representedItemCount===50);
      const total=quantizationWindow(raw.total,raw.wallClock);requireProof(same(total,record.result.coarseWallWindows.total));
      raw.calls.forEach((call,index)=>{requireProof(call.index===index+1&&call.returnedNormally===true&&call.wallStatus==='captured'&&call.cpuStatus==='captured'&&Number.isSafeInteger(call.cpuMicros)&&call.cpuMicros>=0);requireProof(same(quantizationWindow(call,raw.wallClock),record.result.coarseWallWindows.calls[index].window));});
      for(const[field,digest]of [['templateSource','templateSha256'],['clockSource','clockSourceSha256'],['baseSource','baseSourceSha256'],['hostReaderSource','hostReaderSourceSha256'],['guardedCommandGenerator','guardedCommandGeneratorSha256']]){
        const expected={templateSource:'phase-0/resolve-timed-guarded-command.lua',clockSource:'phase-0/resolve-operation-clock.lua',baseSource:'src/companion/resolve-internal.lua',hostReaderSource:'phase-0/evidence-sources/prepare-timed-guarded-command-observed-v1.js.txt',guardedCommandGenerator:'src/resolve-rename-trial.js'}[field];requireProof(record[field]===expected);requireProof(sha(bytes(expected))===record[digest]);
      }
      requireProof(record.hostReaderSourceSha256==='9d5fe0031fe467d4fb2de941e0cc453c30699659b7fc5025cb858bb9a311c5f4'
        &&record.hostReaderRole==='historical-reader-used-for-live-result'&&record.currentHostReaderSource==='phase-0/prepare-timed-guarded-command.js'
        &&sha(bytes(record.currentHostReaderSource))===record.currentHostReaderSourceSha256
        &&record.currentReaderReverifiedHistoricalPrivateOutputs===true&&record.renderedLuaUnchangedAfterReaderHardening===true);
    }
    const clockRecord=json('phase-0/resolve-operation-clock-live-observation.json');
    requireProof(clockRecord.resultFile==='phase-0/resolve-operation-clock-live-result.json'&&clockRecord.resultSha256===pins[clockRecord.resultFile]
      &&clockRecord.hostReaderSource==='phase-0/evidence-sources/prepare-operation-clock-probe-observed-v1.js.txt'
      &&clockRecord.hostReaderSourceSha256==='81e124e48163a9993bde30b308d3402ea15e58cd575cf9f4f0c830d194893cb9'
      &&sha(bytes(clockRecord.hostReaderSource))===clockRecord.hostReaderSourceSha256
      &&clockRecord.hostReaderRole==='historical-reader-used-for-live-result'&&clockRecord.currentHostReaderSource==='phase-0/prepare-operation-clock-probe.js'
      &&sha(bytes(clockRecord.currentHostReaderSource))===clockRecord.currentHostReaderSourceSha256
      &&clockRecord.currentReaderReverifiedHistoricalPrivateOutputs===true&&clockRecord.renderedLuaUnchangedAfterReaderHardening===true);
    requireProof(backup.stage==='backup'&&issued.stage==='issued');
    requireProof(same(backup.calls.map(call=>call.method),['manager.SaveProject','manager.ExportProject']));
    requireProof(same(issued.calls.map(call=>call.method),['item.SetName','manager.SaveProject','manager.CloseProject','manager.LoadProject','item.SetName','manager.SaveProject','manager.CloseProject','manager.LoadProject']));
    requireProof(clock.wallClock.id==='lua-os-time'&&clock.wallClock.reportedResolutionNs===1000000000&&clock.wallClock.monotonic===false);
    const portable=issuedRecord.portableAudit,baseline=issuedRecord.baselineObservation;
    requireProof(portable.file==='phase-0/resolve-operation-rename-portable-audit.json.gz'&&portable.rawSha256===rawAuditSha&&baseline.file==='phase-0/resolve-operation-baseline-observation.json.gz'&&baseline.rawSha256===rawBaselineSha);
    const audit=validatePortableTrialAudit(JSON.parse(unpack(portable.file,rawAuditSha,portable.compressedSha256)));
    const baselineBytes=unpack(baseline.file,rawBaselineSha,baseline.compressedSha256),observation=parseEffectObservation(baselineBytes);
    requireProof(audit.transactionId===issued.transactionId&&audit.outcome.status==='rolled-back'&&audit.effects.before===baselineBytes.toString('utf8')&&audit.effects.after===audit.effects.before);
    requireProof(issuedRecord.independentTrial.status==='rolled-back'&&issuedRecord.independentTrial.mode==='forced-rollback'&&issuedRecord.independentTrial.resultTransport==='retained-file');
    for(const field of ['sourceSha256','incomingSha256','resultingSnapshotSha256','validation','effectObservation'])requireProof(same(issuedRecord.independentTrial[field],audit.outcome[field]));
    const portableIssued=JSON.parse(audit.issuedRecord);requireProof(same(portableIssued.backup,issuedRecord.independentTrial.backup));
    requireProof(issuedRecord.independentTrial.review.planHash===audit.review.planHash&&issuedRecord.independentTrial.review.auditHash===audit.review.auditHash&&same(issuedRecord.independentTrial.review.choices,audit.review.choices));
    requireProof(issuedRecord.independentTrial.review.sourceBindings.safeToApply===false&&same(issuedRecord.independentTrial.review.sourceBindings.hashes,Object.fromEntries(Object.entries(audit.sources).map(([role,text])=>[role,sha(Buffer.from(text))]))));
    requireProof(audit.outcome.resultingSnapshotSha256===issuedRecord.independentTrial.resultingSnapshotSha256&&sha(Buffer.from(audit.resultSnapshot))===audit.outcome.resultingSnapshotSha256);
    const diff=compareEffectObservations(baselineBytes,audit.effects.after);
    requireProof([diff.snapshotChanges,diff.effectChanges,diff.propertyChanges,diff.trackStateChanges].every(changes=>Array.isArray(changes)&&changes.length===0)&&diff.activeTimelineChange===null);
    requireProof(observation.snapshot.project_id===issued.projectId&&observation.snapshot.resolve_version==='21.1.2.10'&&observation.items.length===50&&observation.tracks.length===5&&observation.items.reduce((n,item)=>n+Object.keys(item.properties).length,0)===1600);
    requireProof(same(backupRecord.nativeBackup,issuedRecord.independentTrial.backup)&&backupRecord.nativeBackup.archiveVerified===true&&backupRecord.nativeBackup.mode===0o600&&backupRecord.nativeBackup.size===53560&&backupRecord.nativeBackup.sha256==='c957154992c3dea267c590759ac273ae2f18c4a717bcc26fae58bf5522a31026');
    const resources=json('phase-0/resolve-operation-rename-rss.json');
    requireProof(issuedRecord.resources.file==='phase-0/resolve-operation-rename-rss.json'&&issuedRecord.resources.sha256===pins['phase-0/resolve-operation-rename-rss.json']);
    requireProof(resources.metric==='BSD-ps-rss-KiB'&&resources.status==='completion-marker-observed'&&resources.samples.length===84);
    requireProof(resources.samples.every((sample,index)=>Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0&&Number.isSafeInteger(sample.rssKiB)&&sample.rssKiB>=0&&(!index||sample.elapsedMs>=resources.samples[index-1].elapsedMs)));
    requireProof(resources.firstKiB===resources.samples[0].rssKiB&&resources.lastKiB===resources.samples.at(-1).rssKiB&&resources.maximumObservedKiB===Math.max(...resources.samples.map(sample=>sample.rssKiB)));
    requireProof(issuedRecord.resources.samplerSource==='phase-0/sample-resolve-rss.js'&&sha(bytes('phase-0/sample-resolve-rss.js'))===issuedRecord.resources.samplerSourceSha256);
    requireProof(issuedRecord.resources.completionMarkerSha256===sha(Buffer.from(`FRAMELINE_TIMED_COMMAND_COMPLETE_V1:${issued.probeId}\n`)));
    const scan=json('phase-0/resolve-operation-scan-live-observation.json'),binding=scan.fixtureBinding;
    const historicalScan=json('phase-0/evidence-sources/resolve-operation-scan-observed-20261120.json.txt');
    requireProof(scan.currentRescan===true&&scan.historicalObservation?.file==='phase-0/evidence-sources/resolve-operation-scan-observed-20261120.json.txt'
      &&scan.historicalObservation.sha256===pins[scan.historicalObservation.file]&&same(binding,historicalScan.fixtureBinding)
      &&scan.sourceSha256===historicalScan.sourceSha256&&scan.sourceBytes===historicalScan.sourceBytes);
    requireProof(scan.sourceSha256===sourceXmlSha&&scan.iterations===3&&scan.results.length===6&&scan.sourceUnchanged===true&&scan.safeToApply===false);
    requireProof(binding.projectId===issued.projectId&&binding.observationSha256===rawBaselineSha&&binding.itemCount===50&&binding.trackCount===5&&binding.completionMarkerVerified===true);
    requireProof(binding.nativeResultFile==='phase-0/resolve-operation-fixture-init-live-result.json');
    const initBytes=bytes(binding.nativeResultFile),initialized=JSON.parse(initBytes);requireProof(sha(initBytes)===binding.nativeResultSha256);
    requireProof(initialized.schemaVersion===1&&initialized.operation==='resolve-gate-lab'&&initialized.stage==='initialize'&&initialized.experimental===true&&initialized.safeToApply===false&&initialized.projectId===issued.projectId&&initialized.itemCount===50&&initialized.trackCount===5&&initialized.observationBytes===baselineBytes.length-1);
    requireProof(binding.nativeCompletionMarkerSha256===sha(Buffer.from(`FRAMELINE_GATE_LAB_COMPLETE_V1:${initialized.id}\n`)));
    requireProof(binding.producerSource==='phase-0/evidence-sources/gate-lab-session-observed-v1.js.txt'&&binding.producerRole==='historical-executed-producer'
      &&binding.producerSourceSha256==='596b959ac2435391f8dce68e4541f4de69fc891fd694cb2ee43d299bfc38e0e5'&&sha(bytes(binding.producerSource))===binding.producerSourceSha256);
    requireProof(binding.currentReaderSource==='phase-0/gate-lab-session.js'&&sha(bytes(binding.currentReaderSource))===binding.currentReaderSourceSha256&&binding.renderedLuaUnchangedAfterReaderHardening===true);
    requireProof(binding.input.file==='phase-0/resolve-operation-fixture-input.fcpxml.gz'&&binding.export.file==='phase-0/resolve-operation-fixture-export.fcpxml.gz'&&binding.export.rawSha256===sourceXmlSha);
    const input=unpack(binding.input.file,binding.input.rawSha256,binding.input.compressedSha256),xml=unpack(binding.export.file,sourceXmlSha,binding.export.compressedSha256);
    requireProof(binding.input.rawSha256==='1a0edebc9166f6ff4750945f78d77a447d1e8db43623b9c57a15cb19026f0421'&&scanXml(input.toString('utf8')).clips.length===50);
    const scanned=scanXml(xml.toString('utf8'));requireProof(scanned.clips.length===50&&scanned.media.length===50&&scanned.sequence.durationFrames===2400&&scan.sourceBytes===xml.length);
    requireProof(binding.nativeBaselineArchive.archiveVerified===true&&binding.nativeBaselineArchive.mode===0o600&&binding.nativeBaselineArchive.timelineCount===1&&binding.nativeBaselineArchive.size===53531&&binding.nativeBaselineArchive.sha256==='9037c6c36d3421da38bd888ef9fdb6ab56abbbf69a3bc642bcee0407819b498d');
    scan.results.forEach((row,index)=>{requireProof(row.iteration===Math.floor(index/2)+1&&row.mode===(index%2?'cached-rescan':'first-scan')&&row.cacheHit===Boolean(index%2)&&row.sourceUnchanged===true&&row.sourceSha256===sourceXmlSha&&row.clips===50&&row.media===50&&row.durationFrames===2400&&row.frameDuration===scanned.sequence.frameDuration&&same(row.warnings,scanned.warnings)&&same(row.mediaAvailability,{missing:50})&&Number.isFinite(row.elapsedMs)&&row.elapsedMs>=0);});
    for(const[file,digest]of Object.entries(scan.sourceCodeHashes))requireProof(['src/fcpxml-scan-controller.js','src/fcpxml-scan-worker.js','src/fcpxml-scan-core.js','phase-0/profile-gate-fixture-scan.js'].includes(file)&&sha(bytes(file))===digest);
    const range=mode=>{const times=scan.results.filter(row=>row.mode===mode).map(row=>row.elapsedMs);return{minimumMs:Math.min(...times),maximumMs:Math.max(...times)};};
    return{schemaVersion:1,gateId:'representative-scan-write-reopen',measurementEvidenceComplete:true,readOnly:true,safeToApply:false,fullPreservation:false,releaseSupported:false,
      scope:'Personal installed Resolve Free 21.1.2/build 21.1.20010; one 50-item disposable reviewed rename/save/reopen/rollback with existing larger scan evidence separate.',
      projectId:issued.projectId,itemCount:50,trackCount:5,returnedPropertyValues:1600,exactRepresentedRestoration:true,
      scan:{sourceSha256:sourceXmlSha,sourceBytes:xml.length,pairs:3,firstScan:range('first-scan'),cachedRescan:range('cached-rescan'),warnings:scanned.warnings,mediaAvailability:{missing:50},sourceUnchanged:true},
      wallClock:issued.wallClock,backup:{cpuMicros:backup.total.cpuMicros,wallWindow:quantizationWindow(backup.total,backup.wallClock),nativeArchive:backupRecord.nativeBackup},
      renameAndRollback:{cpuMicros:issued.total.cpuMicros,wallWindow:quantizationWindow(issued.total,issued.wallClock),callCount:issued.calls.length,outcome:'rolled-back'},
      sampledRss:{sampleCount:resources.samples.length,elapsedMs:resources.elapsedMs,firstKiB:resources.firstKiB,lastKiB:resources.lastKiB,maximumObservedKiB:resources.maximumObservedKiB,truePeak:false},
      sourceHashes:sources,limitations:['Wall windows are one-second quantization estimates conditional on no realtime-clock adjustment; no high-resolution native wall clock is claimed.','RSS is sampled process-wide over a window including setup/publication, not a true peak or per-call allocation.','Missing sequence-pattern media references remain missing; this is not media readiness.','Measurement proof does not prove complete enumeration, stable track/export identity, native semantic preservation, ordinary apply or release support.']};
  }catch{throw new Error('operation-performance-evidence-invalid');}
}
if(require.main===module){try{process.stdout.write(JSON.stringify(auditOperationPerformance(),null,2)+'\n');}catch{process.stderr.write('operation-performance-audit-failed\n');process.exitCode=1;}}
module.exports={auditOperationPerformance};
