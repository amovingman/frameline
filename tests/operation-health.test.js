'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createOperationHealth, sanitizeOperationHealth} = require('../src/operation-health');
const {createDiagnosticsReport} = require('../src/diagnostics-report');
const healthOf = (health, domain) => health.snapshot().workflows[domain];

test('native publication stays pending until validation; rollback, retirement and no-op remain distinct', () => {
  const health = createOperationHealth();
  const observe = state => health.observe('nativePull', {busy:false, retained:[{intentId:'private-id',state}]});
  observe('pending-editor-validation');
  assert.equal(healthOf(health,'nativePull').statusCounts.pendingValidation,1);
  assert.equal(healthOf(health,'nativePull').statusCounts.verified,0);
  observe('completed'); assert.equal(healthOf(health,'nativePull').statusCounts.verified,1);
  observe('pending-rollback-editor-validation'); assert.equal(healthOf(health,'nativePull').statusCounts.rolledBack,0);
  observe('rolled-back'); assert.equal(healthOf(health,'nativePull').statusCounts.rolledBack,1);
  health.observe('nativePull',{retained:[{state:'cancelled',retirement:{observedSha256:'private-hash'}},{state:'cancelled'},{state:'no-op'},{state:'recovery-required'}]});
  const counts=healthOf(health,'nativePull').statusCounts;
  assert.equal(counts.retired,1);assert.equal(counts.cancelled,1);assert.equal(counts.noOp,1);assert.equal(counts.recoveryRequired,1);assert.equal(counts.rolledBack,0);
});

test('snapshot status counts are gauges and repeated render/initialize observations cannot inflate them', () => {
  const health=createOperationHealth(), state={busy:false,intents:[{state:'import-prepared'},{state:'imported'},{state:'import-validated'},{state:'import-retired'}],intent:{importCheck:{status:'native-error'}}};
  health.observe('mediaRelink',state);const first=health.snapshot();
  for(let i=0;i<100;i++)health.observe('mediaRelink',state);
  assert.deepEqual(health.snapshot(),first);
  assert.equal(first.workflows.mediaRelink.statusCounts.pendingValidation,2);
  assert.equal(first.workflows.mediaRelink.statusCounts.verified,1);
  assert.equal(first.workflows.mediaRelink.statusCounts.retired,1);
  assert.equal(first.workflows.mediaRelink.editorCheckStatus,'native-error');
});

test('transfer health describes only supplied current selection and retained staging; it makes no success claim for paused jobs',()=>{
 const health=createOperationHealth();health.observe('assetTransfers',{jobs:[{status:'paused',error:'asset-transfer-interrupted'},{status:'completed'},{status:'failed',error:'asset-content-mismatch'}],stagingRecovery:{retainedCount:2,entries:[{path:'/private/media'}]}});
 const row=healthOf(health,'assetTransfers');assert.equal(row.scope,'current-selection');assert.equal(row.statusCounts.paused,1);assert.equal(row.statusCounts.verified,1);assert.equal(row.statusCounts.failed,1);assert.equal(row.unverifiedStagingCount,2);assert.equal(row.errorCodes['asset-transfer-interrupted'],1);
 health.observe('assetTransfers',{jobs:[]});assert.equal(healthOf(health,'assetTransfers').statusCounts.paused,0);
});

test('recovery and integrity status and known errors survive while unobserved domains are explicit',()=>{
 const health=createOperationHealth();assert.deepEqual(healthOf(health,'localIntegrity'),{observed:false});
 health.observe('scanRecovery',{operations:[{status:'interrupted'},{status:'completed'},{status:'failed',error:'scan-failed'}]});health.observe('localIntegrity',{status:'failed',error:'integrity-identity-reused'});
 assert.equal(healthOf(health,'scanRecovery').statusCounts.recoveryRequired,1);assert.equal(healthOf(health,'localIntegrity').statusCounts.failed,1);assert.equal(healthOf(health,'localIntegrity').errorCodes['integrity-identity-reused'],1);
});

test('busy period duration is bounded, monotonic-clamped, and stable during a diagnostics review',()=>{
 let now=100;const health=createOperationHealth({now:()=>now}),observe=busy=>health.observe('localIntegrity',{busy,status:busy?'checking':'verified'});
 observe(true);now+=40;observe(true);const preview=health.snapshot();now+=60;assert.deepEqual(health.snapshot(),preview);
 observe(false);assert.equal(healthOf(health,'localIntegrity').averageBusyPeriodMs,100);assert.equal(healthOf(health,'localIntegrity').busyPeriodsStarted,1);
 observe(false);assert.equal(healthOf(health,'localIntegrity').busyPeriodsCompleted,1);
 for(let i=0;i<130;i++){observe(true);now+=i;observe(false);}
 const row=healthOf(health,'localIntegrity');assert.equal(row.busyPeriodsCompleted,131);assert.equal(row.recentSampleCount,128);assert.equal(row.recentP95BusyPeriodMs,123);
 observe(true);now-=100;observe(false);assert.equal(healthOf(health,'localIntegrity').recentP50BusyPeriodMs>=0,true);
});

test('opaque credentials, basenames, free errors, identifiers and injected keys never enter health or report bytes',()=>{
 const secret='BearerOpaqueCredential-123', basename='take-01.mov',health=createOperationHealth();
 health.observe('nativePull',{busy:false,errorCode:secret,retained:[{intentId:secret,state:secret,errorCode:basename,sourcePath:'/private/client/cut.db'},{state:'constructor'}],editorCheck:{status:secret,menuName:secret}});
 health.observe(secret,{busy:true});
 const snapshot=health.snapshot();assert.equal(snapshot.workflows.nativePull.statusCounts.unknown,2);assert.equal(snapshot.workflows.nativePull.errorCodes['unknown-error'],2);
 snapshot.workflows.nativePull.errorCodes[secret]=4;snapshot.workflows.nativePull.statusCounts[basename]=100;snapshot.workflows.nativePull.privatePath='/private/client';snapshot.workflows[secret]={observed:true};
 const clean=sanitizeOperationHealth(snapshot);assert.equal(clean.workflows.nativePull.errorCodes['unknown-error'],6);
 const {bytes}=createDiagnosticsReport({appVersion:'0.1.0',state:{},syncState:{},operationHealth:snapshot});
 for(const value of [secret,basename,'privatePath','sourcePath','intentId','/private/client'])assert.equal(bytes.includes(value),false,value);
 assert.equal(JSON.parse(bytes).schemaVersion,3);
});

test('observer failures are isolated and exported snapshots cannot mutate retained metrics',()=>{
 const health=createOperationHealth();assert.doesNotThrow(()=>health.observe('nativePull',{get retained(){throw Error('private failure');}}));
 health.observe('nativePull',{retained:[{state:'completed'}]});const snapshot=health.snapshot();snapshot.workflows.nativePull.statusCounts.verified=999;
 assert.equal(healthOf(health,'nativePull').statusCounts.verified,1);
 assert.doesNotThrow(()=>health.observe('unknown',{}));
});

test('a pathological inventory is bounded and explicitly marked truncated',()=>{
 const health=createOperationHealth();health.observe('assetTransfers',{jobs:Array.from({length:10001},()=>({status:'paused'}))});
 const row=healthOf(health,'assetTransfers');assert.equal(row.truncated,true);assert.equal(row.statusCounts.paused,10000);
});
