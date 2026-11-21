'use strict';
// Verify retained authenticated native evidence without replaying publication.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {createClosedProjectReviewCopy}=require('../src/closed-project-review-copy');
const root=path.resolve(__dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex');
(async()=>{const proof=JSON.parse(await fs.readFile(path.join(root,'phase-0/native-review-copy-live-proof.json'))),dir=path.join(root,proof.privateRetentionDirectory),noEffect=()=>{throw Error('audit-cannot-perform-effects');};
 await fs.access(path.join(dir,'service/journal.key'));
 const service=createClosedProjectReviewCopy({directory:path.join(dir,'service'),getCurrentReview:noEffect,getSyncBase:noEffect,mediaPolicy:noEffect});const r=await service.inspect(proof.transactionId);
 assert.equal(r.state,'completed');assert.equal(r.original.sha256,proof.originalSha256);assert.equal(r.candidate.sha256,proof.copySha256);assert.equal(r.editorProof.proofSha256,proof.editorProofSha256);assert.equal(r.editorProof.actualOpenFileBindingVerified,true);assert.equal(r.editorProof.metadataPreserved,true);assert.equal(r.editorProof.opened.sourceBinding.source.path,r.destination.path);assert.equal(r.editorProof.opened.sourceBinding.source.sha256,r.candidate.sha256);assert.equal(r.originalUnchanged,true);assert.equal(r.syncBaseUnchanged,true);assert.equal(r.syncBase.syncBase,proof.nonemptySyncBase);assert.ok(proof.nonemptySyncBase);assert.equal(proof.openResult.status,'opened-copy');
 const before=await fs.readFile(path.join(dir,'original-metadata-before.json')),after=await fs.readFile(path.join(dir,'original-history/metadata.json'));assert.ok(before.equals(after));assert.equal(sha(before),proof.originalHistorySha256);
 const candidate=path.join(dir,'service/transactions',r.transactionId,'candidate/edited.db');assert.equal(sha(await fs.readFile(candidate)),r.candidate.sha256);assert.equal(sha(await fs.readFile(r.original.path)),r.original.sha256);assert.equal(sha(await fs.readFile(r.destination.path)),r.candidate.sha256);
 for(const [file,h]of Object.entries(proof.sourceHashes))assert.equal(sha(await fs.readFile(path.join(root,file))),h,`native proof source changed: ${file}`);
 console.log(JSON.stringify({verified:true,transactionId:r.transactionId,authenticatedEvents:r.journal.events,guardedNativeOpenVerified:true,actualCopyFileReadbackVerified:true,originalProjectUnchanged:true,nonemptySyncBaseUnchanged:true,originalHistoryBytesUnchanged:true,copyBytesVerified:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
