'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),out=path.join(root,'phase-0/observability-desktop'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('observability desktop evidence binds current shipped main, review UI, privacy projection and harness',async()=>{
 const receipt=JSON.parse(await fs.readFile(path.join(out,'verification.json'),'utf8'));
 assert.equal(receipt.schemaVersion,1);assert.ok(Number.isFinite(Date.parse(receipt.observedAt)));
 assert.match(receipt.scope,/callback fixtures only/);assert.match(receipt.scope,/no native publication/);
 const files=['src/main.js','src/preload.js','src/index.html','src/setup-support-renderer.js','src/renderer.js','src/logger.js','src/observability-catalog.js','src/operation-health.js','src/diagnostics-report.js','src/desktop-diagnostics.js','src/adapter-metrics.js','scripts/verify-observability-desktop.cjs'];
 assert.deepEqual(Object.keys(receipt.codeHashes).sort(),files.sort());
 for(const file of files)assert.equal(receipt.codeHashes[file],sha(await fs.readFile(path.join(root,file))),file);
 assert.deepEqual(receipt.stages.map(row=>row.stage),['scan-and-export','restart']);
 const first=receipt.stages[0];for(const flag of ['actualWorkerScan','scanHealthVerified','nativePendingFixtureNotSuccess','changedReviewRefusedBeforeDialog','optionalHealthExcluded','exactReviewedBytesExported','privateMode'])assert.equal(first[flag],true,flag);
 assert.equal(first.rendererErrors,0);assert.deepEqual(first.layouts,[{width:1440,scrollWidth:1440},{width:390,scrollWidth:390}]);
 const restart=receipt.stages[1];assert.equal(restart.scanSessionAttempts,0);assert.equal(restart.nativeFixtureNotPersisted,true);assert.equal(restart.noAutomaticSourceReopen,true);assert.equal(restart.rendererErrors,0);
 for(const check of ['current main observer callbacks feed reviewed diagnostics','changed health revokes prior review before save dialog','known event/error catalog and unknown-error fallback in process output','source export unchanged and zero renderer errors'])assert.ok(receipt.checks.includes(check),check);
 assert.doesNotMatch(JSON.stringify(receipt),/BearerOpaque|\/Users\/|\/private\/|private-cut\.fcpxml|Private client|accessToken|refreshToken/);
 for(const width of [1440,390]){const png=await fs.readFile(path.join(out,'diagnostics-'+width+'.png'));assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(png.length>10000);}
});
