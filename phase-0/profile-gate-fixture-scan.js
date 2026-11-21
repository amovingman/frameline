'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const{createHash}=require('node:crypto');
const{performance}=require('node:perf_hooks');
const{readInput}=require('./integration-input');
const{createFcpXmlScanner,scanXml}=require('../src/fcpxml-adapter');
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;

async function profileFixtureScan({selectedPath,iterations=3,expectedSha256,signal}={}){
  if(!path.isAbsolute(selectedPath||'')||!Number.isSafeInteger(iterations)||iterations<1||iterations>10
    ||expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(expectedSha256))throw new Error('invalid-gate-scan-profile');
  const xmlPath=selectedPath.endsWith('.fcpxmld')?path.join(selectedPath,'Info.fcpxml'):selectedPath;
  if(!xmlPath.endsWith('.fcpxml'))throw new Error('invalid-gate-scan-profile');
  const original=readInput(xmlPath),sourceSha256=hash(original);
  if(expectedSha256!==undefined&&sourceSha256!==expectedSha256)throw new Error('gate-scan-source-mismatch');
  const expected=scanXml(original.toString('utf8'));
  if(expected.clips.length!==50)throw new Error('gate-scan-requires-fifty-clips');
  const results=[];
  for(let iteration=1;iteration<=iterations;iteration++){
    const scanner=createFcpXmlScanner();
    try{
      for(const mode of['first-scan','cached-rescan']){
        const progress=[],memoryBefore=process.memoryUsage(),cpuStart=process.cpuUsage(),started=performance.now();
        const manifest=await scanner.scan(selectedPath,{signal,onProgress:event=>{progress.push(event);}});
        const elapsedMs=performance.now()-started,cpu=process.cpuUsage(cpuStart),after=readInput(xmlPath);
        if(!after.equals(original)||manifest.sourceHash!==sourceSha256||manifest.clips.length!==expected.clips.length
          ||manifest.media.length!==expected.media.length||manifest.sequence.durationFrames!==expected.sequence.durationFrames
          ||manifest.sequence.frameDuration!==expected.sequence.frameDuration||JSON.stringify(manifest.warnings)!==JSON.stringify(expected.warnings))throw new Error('gate-scan-profile-mismatch');
        const cacheHit=progress.some(event=>event.cacheHit===true);if(cacheHit!==(mode==='cached-rescan'))throw new Error('gate-scan-cache-mismatch');
        const availability=new Map();for(const media of manifest.media)availability.set(media.availability,(availability.get(media.availability)||0)+1);
        results.push({iteration,mode,sourceSha256,sourceUnchanged:true,clips:manifest.clips.length,media:manifest.media.length,
          durationFrames:manifest.sequence.durationFrames,frameDuration:manifest.sequence.frameDuration,warnings:manifest.warnings,
          mediaAvailability:Object.fromEntries([...availability.entries()].sort(([a],[b])=>a<b?-1:a>b?1:0)),elapsedMs,processCpuMicros:cpu,
          processRssBeforeBytes:memoryBefore.rss,processRssAfterBytes:process.memoryUsage().rss,cacheHit,
          phases:[...new Set(progress.map(event=>event.phase))],manifestSha256:hash(JSON.stringify(canonical(manifest)))});
      }
    }finally{await scanner.dispose();}
  }
  return{schemaVersion:1,operation:'resolve-gate-fixture-worker-profile',readOnly:true,safeToApply:false,observedOn:new Date().toISOString().slice(0,10),
    sourceSha256,sourceBytes:original.length,iterations,runtime:{node:process.versions.node,platform:process.platform,arch:process.arch},
    results,sourceUnchanged:readInput(xmlPath).equals(original),
    sourceCodeHashes:Object.fromEntries(await Promise.all(['src/fcpxml-scan-controller.js','src/fcpxml-scan-worker.js','src/fcpxml-scan-core.js','phase-0/profile-gate-fixture-scan.js']
      .map(async file=>[file,hash(await fs.readFile(path.join(__dirname,'..',file)))]))),
    limitations:['Wall time is Node performance.now elapsed time for the actual production worker; fresh samples include worker startup.',
      'Availability is checked as referenced by the actual editor export; no media is regenerated or relinked.',
      'Node CPU/RSS include its worker threads, not editor CPU/RSS or a true memory peak.',
      'Scanner coverage is bounded picture content; warnings and unresolved identities remain unchanged.']};
}
if(require.main===module){const[selectedPath,expectedSha256]=process.argv.slice(2);profileFixtureScan({selectedPath,expectedSha256})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(()=>{process.stderr.write('resolve-gate-scan-profile-failed\n');process.exitCode=1;});}
module.exports={profileFixtureScan};
