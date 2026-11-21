'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{gunzipSync,gzipSync}=require('node:zlib');
const{readInput}=require('../phase-0/integration-input');
const{auditNativeBlindIdentityEvidence}=require('../phase-0/native-blind-identity-evidence-audit');
const root=path.resolve(__dirname,'..'),folder='phase-0/native-blind-identity-evidence';
function substitute(relative,mutate){const selected=path.join(root,relative);return filename=>{const bytes=readInput(filename);return filename===selected?mutate(bytes):bytes;};}
test('three actual saved checkpoints close only the personal clip/track identity gate with 24 independent associations and complete Free witnesses',()=>{
 const result=auditNativeBlindIdentityEvidence();assert.equal(result.status,'complete');assert.equal(result.gateId,'stable-clip-and-track-identity');assert.equal(result.stableClipIdentityProven,true);assert.equal(result.stableTrackIdentityProven,true);assert.equal(result.personalScopeEvidenceComplete,true);assert.equal(result.independentBlindCases,3);assert.equal(result.independentTrackAssociations,24);assert.equal(result.uniqueObservedNativeTrackIds,10);assert.deepEqual(result.itemsPerCase,[52,52,52]);assert.deepEqual(result.apiLocationWitnessesPerCase,[52,52,52]);assert.equal(result.clipPersistence.movedClipCount,1);assert.equal(result.clipPersistence.renamedClipCount,1);assert.equal(result.clipPersistence.retainedTracksWithNewIndex,2);assert.equal(result.abaFreshIdentity.identityReusedFromEarlierCase,false);
 assert.equal(result.savedCheckpointScopeOnly,true);assert.equal(result.currentUnsavedStateBindingProven,false);assert.equal(result.interruptedOriginalStageCompletionProven,false);assert.equal(result.sourceBoundSaveReopenContinuationVerified,true);assert.equal(result.orderOnlyDiagnosticRecomputed,true);assert.equal(result.unsavedIntermediateExportsUsedForMutationProof,false);assert(result.unsavedIntermediateExports.every(row=>row.identityFactsMatchPriorSavedCheckpoint));assert.equal(result.nativeGraphsReconstructedFromArchives,false);assert.equal(result.issuedNativeSourcesReconstructed,false);assert.equal(result.fullNativePreservationProven,false);assert.equal(result.ordinaryApplySupported,false);assert.equal(result.safeToApply,false);
});
test('public raw challenge cannot replace a frozen-prediction echo even with valid gzip/JSON',()=>{
 const changed=substitute(folder+'/recreated-challenge.json.gz',bytes=>{const raw=JSON.parse(gunzipSync(bytes));raw.frozenPredictionCanonicalSha256='0'.repeat(64);return gzipSync(JSON.stringify(raw)+'\n');});assert.throws(()=>auditNativeBlindIdentityEvidence(changed),/raw-hash/);
});
test('an amended proof source or operational boundary cannot reuse the native evidence claim',()=>{
 for(const relative of['phase-0/prepare-native-blind-challenge.js','phase-0/prepare-native-blind-continuation.js','phase-0/supported-native-track-binding.js'])assert.throws(()=>auditNativeBlindIdentityEvidence(substitute(relative,bytes=>Buffer.concat([bytes,Buffer.from('\n// changed source\n')]))),/source-hash/);
});
test('self-reported receipt edits cannot erase interrupted provenance, truncate sources or promote live-unsaved support',()=>{
 const changed=substitute(folder+'/receipt.json',bytes=>{const receipt=JSON.parse(bytes);receipt.sourceHashes={};receipt.originalInterruptedStageRetained=false;receipt.currentUnsavedStateBindingProven=true;return Buffer.from(JSON.stringify(receipt));});assert.throws(()=>auditNativeBlindIdentityEvidence(changed),/receipt-hash/);
});
test('pinned native facts refuse an invented original-stage success or removed ABA predecessor',()=>{
 const changed=substitute(folder+'/retained-facts.json.gz',bytes=>{const facts=JSON.parse(gunzipSync(bytes));facts.interrupted.resultPresent=true;facts.cases[0].capture.graphs[0].timelines[0].tracks.pop();return gzipSync(JSON.stringify(facts)+'\n');});assert.throws(()=>auditNativeBlindIdentityEvidence(changed),/raw-hash/);
});
