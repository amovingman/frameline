'use strict';
// Audit retained native proof without replaying an editor command or file write.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto'),assert=require('node:assert/strict');
const {createClosedProjectApplyTransaction}=require('../src/closed-project-apply-transaction');
const root=path.resolve(__dirname,'..'),sha=b=>createHash('sha256').update(b).digest('hex');
(async()=>{const proof=JSON.parse(await fs.readFile(path.join(root,'phase-0/safe-apply-live-proof.json'))),retained=path.join(root,proof.privateRetentionDirectory);
 const unreachable=()=>{throw Error('audit-cannot-perform-effects');};
 const reader=createClosedProjectApplyTransaction({directory:path.join(retained,'native-transactions'),verifyPlan:unreachable,adapter:Object.fromEntries(['inspectSource','createBackup','createCandidate','verifyPreservation','publish','verifyEditor'].map(k=>[k,unreachable]))});
 const final=await reader.inspect(proof.transactionId);assert.equal(final.state,'rolled-back');assert.equal(final.source.sha256,proof.sourceSha256);assert.equal(final.candidate.sha256,proof.candidateSha256);assert.equal(final.backup.sha256,proof.sourceSha256);assert.equal(final.editorProof.proofSha256,proof.restore.proofSha256);
 for(const [key,expected]of [['backup',proof.sourceSha256],['candidate',proof.candidateSha256]]){const relative=path.relative('/private/tmp/frameline-safe-apply-live-fgmW5v/native-transactions',final[key].path);assert.ok(!relative.startsWith('..'));assert.equal(sha(await fs.readFile(path.join(retained,'native-transactions',relative))),expected);}
 assert.equal(final.nativeRevisions.length,2);for(const [index,direction]of ['apply','restore'].entries()){assert.equal(final.nativeRevisions[index].revisionId,proof[direction].revisionId);}
 const entries=(await fs.readdir(path.join(retained,'native-transactions',proof.transactionId))).filter(n=>/^\d{6}\.json$/.test(n)).sort();
 const records=await Promise.all(entries.map(async n=>JSON.parse(await fs.readFile(path.join(retained,'native-transactions',proof.transactionId,n)))));const applied=records.find(x=>x.record.state==='completed').record;
 for(const [record,claim]of [[applied,proof.apply],[final,proof.restore]]){assert.equal(record.editorProof.proofSha256,claim.proofSha256);assert.equal(record.editorProof.openEvidence.actualOpenFileBindingVerified,true);assert.equal(record.editorProof.metadataPreserved,true);assert.equal(record.editorProof.openEvidence.sourceBinding.source.sha256,claim.sourceSha256);assert.equal(record.editorProof.sourceSha256,claim.sourceSha256);}
 assert.equal(sha(await fs.readFile(final.source.path)),proof.sourceSha256);
 console.log(JSON.stringify({verified:true,operation:'audit-retained-native-apply-and-restoration',transactionId:proof.transactionId,authenticatedEvents:entries.length,backupVerified:true,nativeApplyVerified:true,nativeRestorationVerified:true,currentSourceMatchesOriginal:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
