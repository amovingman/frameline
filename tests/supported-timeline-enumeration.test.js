'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const{spawnSync}=require('node:child_process');
const{readSupportedTimelineEnumeration}=require('../phase-0/supported-timeline-enumeration');
test('supported enumeration refuses raw/caller-asserted complete data without source-bound owner traversal and sanitizes CLI failure',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frameline-supported-enumeration-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const input=path.join(directory,'private-source.json');fs.writeFileSync(input,JSON.stringify({operation:'resolve-timeline-enumeration',completeForProfile:true,savedCheckpointEvidenceVerified:true,activeOwnerCoverageRequired:true}));
 await assert.rejects(readSupportedTimelineEnumeration(input),/unsupported-enumeration-capture-kind/);
 fs.writeFileSync(input,JSON.stringify({operation:'prepare-enumeration-capture-v2',completeForProfile:true,savedCheckpointEvidenceVerified:true}));
 await assert.rejects(readSupportedTimelineEnumeration(input),/invalid-enumeration-capture-record/);
 const result=spawnSync(process.execPath,[path.join(__dirname,'../phase-0/supported-timeline-enumeration.js'),input],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,1);assert.equal(result.stdout,'');assert.equal(result.stderr,'supported-timeline-enumeration-refused\n');assert(!result.stderr.includes(directory));
});
