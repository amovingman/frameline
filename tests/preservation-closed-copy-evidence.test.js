'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const{auditClosedCopyPreservation}=require('../phase-0/preservation-closed-copy-evidence');
const{readInput}=require('../phase-0/integration-input');
test('closed-copy proof compares all cells, binds the exact UUID target and retains limited runtime scope',()=>{const r=auditClosedCopyPreservation();assert.equal(r.cellsIncludingRowid,9788);assert.equal(r.authorizedNameCellChanges,1);assert.equal(r.unexplainedCellChanges,0);assert.equal(r.postEditorDatabaseBytesIdentical,true);assert.equal(r.ordinaryApplySupported,false);assert.equal(r.sdkSavePreservationProven,false);assert.equal(r.originalBaselineRestorationProven,false);});
test('changed producer, evidence or receipt cannot retain the preservation claim',()=>{for(const suffix of ['receipt.json','evidence.json.gz','prepare-preservation-open-verification.js'])assert.throws(()=>auditClosedCopyPreservation(file=>{const b=readInput(file);if(file.endsWith(suffix)){const bad=Buffer.from(b);bad[0]^=1;return bad;}return b;}));});
