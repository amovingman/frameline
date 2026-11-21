'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{gunzipSync}=require('node:zlib');
const{verifySavedReplacement,verifyEndpointSourceHashes}=require('../phase-0/native-blind-saved-endpoint');
test('saved endpoint accepts one fresh empty same-slot UUID and rejects stale unsaved export or collateral changes',()=>{
 const report=JSON.parse(fs.readFileSync(path.join(__dirname,'../phase-0/native-blind-identity-evidence/initial-pair.json'))),observation=JSON.parse(gunzipSync(fs.readFileSync(path.join(__dirname,'../phase-0/native-blind-identity-evidence/initial-initial-result.json.gz')))).after;
 const before=report.capture.graphs[1],after=structuredClone(before),target=after.timelines[0].tracks.find(t=>t.kind==='video'&&t.currentVectorIndex===4);target.nativeTrackId=randomUUID();
 const result=verifySavedReplacement(before,after,observation);assert.equal(result.sameSlotSameNameEmptyReplacementVerified,true);assert.equal(result.retainedTrackCount,7);
 assert.throws(()=>verifySavedReplacement(before,before,observation),/replacement-differs/);
 const collateral=structuredClone(after);collateral.timelines[0].tracks.find(t=>t.kind==='audio').nativeTrackId=randomUUID();assert.throws(()=>verifySavedReplacement(before,collateral,observation),/replacement-differs/);
 const moved=structuredClone(after);moved.timelines[0].tracks.find(t=>t.kind==='video'&&t.currentVectorIndex===4).currentVectorIndex=3;assert.throws(()=>verifySavedReplacement(before,moved,observation));
});
test('saved endpoint requires every exact frozen transitive source rather than a caller-selected subset',()=>{
 const files=['phase-0/prepare-native-blind-perturb.js','phase-0/prepare-native-blind-capture.js','phase-0/prepare-native-blind-challenge.js',
  'phase-0/native-track-location-binding.js','phase-0/resolve-native-location-graph.py','phase-0/resolve-native-track-identity.py','phase-0/compare-native-resolve-exports.py',
  'src/companion/resolve-internal.lua','src/companion/resolve-effects.lua','src/resolve-property-contract.json'];
 const{sha}=require('../phase-0/native-track-location-binding');
 const hashes=Object.fromEntries(files.map(file=>[file,sha(fs.readFileSync(path.join(__dirname,'..',file)))]));assert.equal(verifyEndpointSourceHashes(hashes),true);
 assert.throws(()=>verifyEndpointSourceHashes({}),/incomplete/);const subset={...hashes};delete subset[files[0]];assert.throws(()=>verifyEndpointSourceHashes(subset),/incomplete/);
 const extra={...hashes,'src/not-an-issued-source.js':'a'.repeat(64)};assert.throws(()=>verifyEndpointSourceHashes(extra),/incomplete/);
 const wrong={...hashes,[files[0]]:'0'.repeat(64)};assert.throws(()=>verifyEndpointSourceHashes(wrong),/changed/);
});
