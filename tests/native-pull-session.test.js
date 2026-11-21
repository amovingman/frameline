'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {closedProjectFixture, sha} = require('./helpers/closed-project-apply-fixture');
const {createClosedProjectCheckpointStore} = require('../src/closed-project-checkpoint-store');
const {createNativePullSession} = require('../src/native-pull-session');
async function setup(t,{localName='Local choice',incomingName='Incoming choice',localFlags=7,incomingFlags=7,...sessionOptions}={}) {
 const f=await closedProjectFixture(t);
 const bindingFor=sourcePath=>({schemaVersion:1,sourcePath,projectName:f.fixture.projectName,libraryRoot:path.dirname(path.dirname(sourcePath)),configSha256:sha('configured libraries'),expectedCurrentDatabase:{DbType:'Disk',DbName:path.basename(path.dirname(path.dirname(sourcePath)))},expectedCurrentFolder:'Root'});
 const options={directory:path.join(f.root,'identities'),guard:f.guard,sourceBindingService:{async prepareClosedProjectSourceBinding({sourcePath}){return bindingFor(sourcePath);}}};
 const store=createClosedProjectCheckpointStore(options);
 const sql=(query,params=[])=>execFileSync('python3',['-B','-c','import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit();c.close()',f.sourcePath,query,JSON.stringify(params)]);
 const base=await store.capture({sourcePath:f.sourcePath}),baseBytes=await fs.readFile(f.sourcePath);
 sql('UPDATE Sm2TiItem SET Name=?,Flags=?',[incomingName,incomingFlags]);const incoming=await store.capture({sourcePath:f.sourcePath});
 await fs.writeFile(f.sourcePath,baseBytes);sql('UPDATE Sm2TiItem SET Name=?,Flags=?',[localName,localFlags]);
 const mediaPolicy=async({plan})=>({schemaVersion:1,policy:'unchanged-references',verified:true,sourceSha256:plan.source.sha256,bindingSha256:sha('binding'),report:{databaseSha256:plan.source.sha256,counts:{missing:0,unknown:0},opaqueNativeMediaCells:0},preservesExistingAvailabilityConditionOnly:true,portableCopyVerified:false});
 const sessionConfig={directory:path.join(f.root,'pulls'),store,mediaPolicy,...sessionOptions};
 const session=createNativePullSession(sessionConfig);await session.initialize();
 return{...f,store,session,sessionConfig,sql,base,incoming,options,async prepare(){return session.prepare({baseCheckpointId:base.checkpointId,incomingCheckpointId:incoming.checkpointId});}};
}
const nameConflict=r=>r.changes.find(c=>c.column==='Name'&&c.status==='conflicting');
test('a real native conflict retains exact choices, deterministic executable plan and path-free state across restart',async t=>{
 const f=await setup(t),initial=await f.prepare();assert.equal(initial.state,'blocked');
 const conflict=nameConflict(initial);assert.ok(conflict);assert.equal(initial.plan.blockers.some(b=>b.code==='conflict-choice-required'),true);
 const chosen=await f.session.choose(initial.intentId,conflict.id,'take-incoming');assert.equal(chosen.state,'ready');assert.equal(chosen.plan.edit.oldName,'Local choice');assert.equal(chosen.plan.edit.newName,'Incoming choice');
 const trusted=await f.session.readIntent(initial.intentId);assert.equal(trusted.plan.executionPlan.review.auditHash,trusted.plan.auditHash);assert.equal(trusted.plan.checkpointBindings.local.checkpointId,trusted.localCheckpointId);assert.equal(trusted.choices[0].changeId,conflict.id);
 const serialized=JSON.stringify(f.session.getState());assert.equal(serialized.includes(f.root),false);assert.equal(serialized.includes('sourcePath'),false);
 const restarted=createNativePullSession(f.sessionConfig);await restarted.initialize();assert.equal(restarted.getState().intent.plan.planId,chosen.plan.planId);assert.equal(restarted.getState().intent.state,'ready');assert.deepEqual(restarted.getState().intent.choices,chosen.choices);assert.equal(restarted.isReviewLocked(),true);
 const refreshed=await restarted.refresh(initial.intentId);assert.equal(refreshed.plan.planId,chosen.plan.planId);assert.deepEqual(refreshed.choices,chosen.choices);assert.equal(refreshed.stale,false);
});
test('fresh source mutation clears stale choices but preserves their authenticated audit history',async t=>{
 const f=await setup(t),initial=await f.prepare(),chosen=await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');
 f.sql('UPDATE Sm2TiItem SET Name=?',['A later local edit']);
 const refreshed=await f.session.refresh(initial.intentId);assert.equal(refreshed.state,'blocked');assert.equal(refreshed.stale,true);assert.deepEqual(refreshed.choices,[]);assert.notEqual(refreshed.sourceSha256,chosen.sourceSha256);assert.notEqual(refreshed.plan.planId,chosen.plan.planId);
 const old=await fs.readFile(path.join(f.sessionConfig.directory,'intents',initial.intentId,'000002.json'),'utf8');assert.match(old,/take-incoming/);assert.match(old,new RegExp(chosen.plan.planId));
 const next=await f.session.choose(initial.intentId,nameConflict(refreshed).id,'take-incoming');f.sql('UPDATE Sm2TiItem SET Flags=11');const stale=await f.session.choose(initial.intentId,nameConflict(next).id,'keep-local');assert.equal(stale.state,'needs-review');assert.equal(stale.errorCode,'native-pull-review-stale');assert.deepEqual(stale.choices,[]);
});
test('unsupported conflicts remain explicit, keep-local resolves them and invalid or invented choices fail closed',async t=>{
 const f=await setup(t,{localName:'Local choice',incomingName:'Incoming choice',localFlags:10,incomingFlags:20}),initial=await f.prepare(),flags=initial.changes.find(c=>c.column==='Flags');assert.equal(flags.status,'conflicting');
 await assert.rejects(f.session.choose(initial.intentId,sha('invented'),'take-incoming'),/choice-target-invalid/);
 await assert.rejects(f.session.choose(initial.intentId,flags.id,'merge'),/choice-invalid/);
 let result=await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');result=await f.session.choose(initial.intentId,flags.id,'take-incoming');assert.equal(result.state,'blocked');assert.ok(result.plan.blockers.some(b=>b.code==='unsupported-accepted-change'));
 result=await f.session.choose(initial.intentId,flags.id,'keep-local');assert.equal(result.state,'ready');assert.equal(result.choices.length,2);
});
test('keep-local no-op never executes and cannot revive an old intent while another review is active',async t=>{
 let prepareCalls=0;const f=await setup(t,{executionService:{async prepare(){prepareCalls++;}}}),initial=await f.prepare(),noop=await f.session.choose(initial.intentId,nameConflict(initial).id,'keep-local');assert.equal(noop.state,'no-op');assert.equal(noop.plan.edit,null);await assert.rejects(f.session.apply(initial.intentId),/plan-not-ready/);assert.equal(prepareCalls,0);
 const second=await f.prepare();await assert.rejects(f.session.refresh(noop.intentId),/review-locked/);assert.equal(f.session.getState().intent.intentId,second.intentId);
});
test('journal tampering or missing historical events cannot authorize a retained plan',async t=>{
 const f=await setup(t),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');
 const file=path.join(f.sessionConfig.directory,'intents',initial.intentId,'000002.json'),event=JSON.parse(await fs.readFile(file));event.record.choices[0].choice='keep-local';await fs.writeFile(file,JSON.stringify(event));
 const restarted=createNativePullSession(f.sessionConfig);await assert.rejects(restarted.initialize(),/journal-invalid/);assert.equal(restarted.getState().reviewLocked,true);
});
test('invalid and nonexistent IDs never create authority directories or escape the intent root',async t=>{
 const f=await setup(t),absent=randomUUID();await assert.rejects(f.session.select(absent),/ENOENT/);assert.deepEqual(await fs.readdir(path.join(f.sessionConfig.directory,'intents')),[]);
 await assert.rejects(f.session.refresh('../elsewhere'),/intent-id-invalid/);assert.deepEqual(await fs.readdir(path.join(f.sessionConfig.directory,'locks')),[]);
});
test('Apply recalculates against fresh source bytes before creating any execution intent',async t=>{
 let prepares=0;const f=await setup(t,{executionService:{async prepare(){prepares++;}}}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');f.sql('UPDATE Sm2TiItem SET Name=?',['Changed after review']);
 const result=await f.session.apply(initial.intentId);assert.equal(result.state,'needs-review');assert.equal(result.stale,true);assert.deepEqual(result.choices,[]);assert.equal(prepares,0);
});
test('preparation intent is durable before execution, orphan native transaction is recovered and pending effects cannot refresh',async t=>{
 let transaction=null,preparedRecord=null,applyCalls=0;const execution={async prepare(id){preparedRecord=await f.session.readIntent(id);transaction={transactionId:randomUUID(),state:'prepared',plan:preparedRecord.plan.executionPlan};throw Error('crash after core commit');},async findTransaction(){return transaction;},async recover(){return transaction;},async apply(){applyCalls++;transaction={...transaction,state:'pending-editor-validation'};return transaction;}};
 const f=await setup(t,{executionService:execution}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');await assert.rejects(f.session.apply(initial.intentId),/crash after core commit/);assert.equal(preparedRecord.state,'preparing-transaction');assert.equal((await f.session.readIntent(initial.intentId)).state,'preparing-transaction');assert.equal(applyCalls,0);
 const restarted=createNativePullSession(f.sessionConfig);await restarted.initialize();assert.equal(restarted.getState().intent.state,'transaction-prepared');assert.equal(restarted.getState().intent.transactionId,transaction.transactionId);assert.equal(applyCalls,0);await assert.rejects(restarted.refresh(initial.intentId),/refresh-not-ready/);
 const applied=await restarted.apply(initial.intentId);assert.equal(applied.state,'pending-editor-validation');assert.equal(applyCalls,1);await assert.rejects(restarted.apply(initial.intentId),/plan-not-ready/);await assert.rejects(restarted.cancel(initial.intentId),/cancel-not-ready/);await assert.rejects(restarted.choose(initial.intentId,nameConflict(initial).id,'keep-local'),/choice-not-ready/);
});
test('startup only passively inspects pending transactions while Resolve may be open',async t=>{
 let transaction=null,inspects=0,recoveries=0;const execution={async prepare(id){const r=await f.session.readIntent(id);return transaction={transactionId:randomUUID(),state:'prepared',plan:r.plan.executionPlan};},async apply(){transaction={...transaction,state:'pending-editor-validation'};return transaction;},async findTransaction(){return transaction;},async inspect(){inspects++;return transaction;},async recover(){recoveries++;throw Object.assign(Error('Resolve running'),{code:'closed-project-resolve-running'});}};
 const f=await setup(t,{executionService:execution}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');await f.session.apply(initial.intentId);
 const restarted=createNativePullSession(f.sessionConfig);await restarted.initialize();assert.equal(restarted.getState().intent.state,'pending-editor-validation');assert.equal(inspects,1);assert.equal(recoveries,0);await assert.rejects(restarted.recover(initial.intentId),/Resolve running/);assert.equal(recoveries,1);
});
test('unsafe stored Name and host error details are absent from public session state',async t=>{
 const f=await setup(t,{localName:'/private/local-file\nName'}),initial=await f.prepare(),chosen=await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');assert.equal(chosen.state,'ready');assert.equal(chosen.plan.edit.oldName,'Stored value');assert.equal(JSON.stringify(f.session.getState()).includes('/private/local-file'),false);
 const trusted=await f.session.readIntent(initial.intentId);assert.equal(trusted.plan.executionPlan.edit.oldName,'/private/local-file\nName');
 const failing=createNativePullSession({...f.sessionConfig,store:{...f.store,async capture(){throw Object.assign(Error('sensitive '+f.root),{code:f.root});}}});await failing.initialize();await assert.rejects(failing.refresh(initial.intentId));assert.equal(failing.getState().error,'native-pull-action-failed');assert.equal(JSON.stringify(failing.getState()).includes(f.root),false);
});
test('actual process death after committing an executable intent preserves exact audit and plan without replay',async t=>{
 const f=await setup(t),initial=await f.prepare(),script=path.join(f.root,'commit-and-die.cjs');
 await fs.writeFile(script,`
 const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');const sha=b=>createHash('sha256').update(b).digest('hex');
 const sourcePath=${JSON.stringify(f.sourcePath)},metadata=${JSON.stringify(f.metadata)},projectName=${JSON.stringify(f.fixture.projectName)};
 const guard={async inspect({sourcePath,expectedSourceHash}){const b=await fs.readFile(sourcePath),s=await fs.stat(sourcePath);if(expectedSourceHash&&sha(b)!==expectedSourceHash)throw Error('stale');return{schemaVersion:1,sourcePath,sha256:sha(b),size:b.length,identity:{device:String(s.dev),inode:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs},directoryIdentity:{},metadata,installedBuild:{version:'test-only'},freshObservationOnly:true,safeToApply:false};}};
 const store=require(${JSON.stringify(path.resolve(__dirname,'../src/closed-project-checkpoint-store'))}).createClosedProjectCheckpointStore({directory:${JSON.stringify(f.options.directory)},guard,sourceBindingService:{async prepareClosedProjectSourceBinding({sourcePath}){return{schemaVersion:1,sourcePath,projectName,libraryRoot:path.dirname(path.dirname(sourcePath)),configSha256:sha('configured libraries'),expectedCurrentDatabase:{DbType:'Disk',DbName:path.basename(path.dirname(path.dirname(sourcePath)))},expectedCurrentFolder:'Root'};}}});
 const session=require(${JSON.stringify(path.resolve(__dirname,'../src/native-pull-session'))}).createNativePullSession({directory:${JSON.stringify(f.sessionConfig.directory)},store,mediaPolicy:async({plan})=>({schemaVersion:1,policy:'unchanged-references',verified:true,sourceSha256:plan.source.sha256,bindingSha256:sha('binding'),report:{databaseSha256:plan.source.sha256,counts:{missing:0,unknown:0},opaqueNativeMediaCells:0},preservesExistingAvailabilityConditionOnly:true,portableCopyVerified:false}),onCheckpoint:async(_,record)=>{if(record.state==='ready')process.exit(73);}});
 (async()=>{await session.initialize();await session.choose(${JSON.stringify(initial.intentId)},${JSON.stringify(nameConflict(initial).id)},'take-incoming');})().catch(e=>{console.error(e);process.exit(1);});
 `,{mode:0o600});
 assert.throws(()=>execFileSync(process.execPath,[script],{stdio:['ignore','pipe','pipe']}),e=>e.status===73);
 const restarted=createNativePullSession(f.sessionConfig);await restarted.initialize();const recovered=restarted.getState().intent;assert.equal(recovered.state,'ready');assert.equal(recovered.choices[0].choice,'take-incoming');const retained=await restarted.readIntent(initial.intentId);assert.equal(retained.plan.auditHash,retained.plan.executionPlan.review.auditHash);assert.equal(retained.transactionId,null);await restarted.refresh(initial.intentId);assert.equal(restarted.getState().intent.plan.planId,recovered.plan.planId);
});
test('Apply clears a stale choice when the conflict disappeared instead of reusing its old target ID',async t=>{
 let prepares=0;const f=await setup(t,{executionService:{async prepare(){prepares++;}}}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');
 f.sql('UPDATE Sm2TiItem SET Name=?',['Incoming choice']);const result=await f.session.apply(initial.intentId);assert.equal(result.state,'needs-review');assert.equal(result.stale,true);assert.deepEqual(result.choices,[]);assert.equal(result.plan.status,'no-op');assert.equal(prepares,0);
 const before=(await f.session.readIntent(initial.intentId)).journal;await f.session.initialize();assert.deepEqual((await f.session.readIntent(initial.intentId)).journal,before);
});
test('failed Apply can be retired only after fresh authenticated proof of the exact original source',async t=>{
 let transaction=null,classification='original-safe-replan',coreCancels=0;
 const execution={async prepare(id){const record=await f.session.readIntent(id);return transaction={transactionId:randomUUID(),state:'prepared',plan:record.plan.executionPlan};},async apply(){transaction={...transaction,state:'publication-unverified'};throw Error('publisher refused');},async recover(){return{...transaction,recovery:{classification,mayRollback:false,mayValidate:false,observedSha256:classification==='original-safe-replan'?transaction.plan.source.sha256:sha(classification)}};},async cancel(){coreCancels++;throw Error('must retain failed core record');}};
 const f=await setup(t,{executionService:execution}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');await assert.rejects(f.session.apply(initial.intentId),/publisher refused/);assert.equal(f.session.getState().intent.state,'recovery-required');assert.equal(f.session.getState().intent.canRetire,true);
 for(const unsafe of ['candidate-needs-editor-validation','diverged-manual-review','original-needs-editor-validation']){classification=unsafe;await assert.rejects(f.session.cancel(initial.intentId),/cancel-not-ready/);assert.equal((await f.session.readIntent(initial.intentId)).state,'recovery-required');}
 classification='original-safe-replan';const retired=await f.session.cancel(initial.intentId);assert.equal(retired.state,'cancelled');assert.equal(retired.transactionState,'publication-unverified');assert.equal(retired.retirement.transactionId,transaction.transactionId);assert.equal(retired.retirement.planId,transaction.plan.planId);assert.equal(retired.retirement.observedSha256,transaction.plan.source.sha256);assert.equal(coreCancels,0);assert.equal(f.session.isReviewLocked(),false);
 const retained=await f.session.readIntent(initial.intentId);assert.equal(retained.plan.executionPlan.planId,transaction.plan.planId);assert.equal(retained.retirement.classification,'original-safe-replan');await assert.rejects(f.session.apply(initial.intentId),/plan-not-ready/);const next=await f.prepare();assert.notEqual(next.intentId,initial.intentId);
});
test('cancelled retirement stays terminal after later candidate bytes and restart without recovery, publication or validation calls',async t=>{
 let transaction=null,recoveries=0,rollbacks=0,validations=0;
 const execution={async prepare(id){const record=await f.session.readIntent(id);return transaction={transactionId:randomUUID(),state:'prepared',plan:record.plan.executionPlan};},async apply(){transaction={...transaction,state:'publication-unverified'};throw Error('publication refused');},async recover(){recoveries++;return{...transaction,recovery:{classification:'original-safe-replan',observedSha256:transaction.plan.source.sha256}};},async rollback(){rollbacks++;return transaction;},async validate(){validations++;return transaction;}};
 const f=await setup(t,{executionService:execution}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');await assert.rejects(f.session.apply(initial.intentId),/publication refused/);const retired=await f.session.cancel(initial.intentId);assert.equal(retired.state,'cancelled');const committed=await f.session.readIntent(initial.intentId),before=recoveries;
 f.sql('UPDATE Sm2TiItem SET Name=?',['Incoming choice']);const laterBytes=await fs.readFile(f.sourcePath);
 const restarted=createNativePullSession(f.sessionConfig);await restarted.initialize();assert.equal(restarted.isReviewLocked(),false);assert.equal((await restarted.recover(initial.intentId)).state,'cancelled');assert.deepEqual((await restarted.readIntent(initial.intentId)).journal,committed.journal);assert.equal(recoveries,before);
 await assert.rejects(restarted.rollback(initial.intentId),/intent-terminal/);await assert.rejects(restarted.validate(initial.intentId),/intent-terminal/);assert.equal(rollbacks,0);assert.equal(validations,0);assert.equal((await restarted.readIntent(initial.intentId)).state,'cancelled');assert.deepEqual(await fs.readFile(f.sourcePath),laterBytes);
});
test('an active newer intention blocks rollback and validation of an older completed transaction',async t=>{
 let transaction=null,rollbacks=0,validations=0;
 const execution={async prepare(id){const r=await f.session.readIntent(id);return transaction={transactionId:randomUUID(),state:'prepared',plan:r.plan.executionPlan};},async apply(){return transaction={...transaction,state:'pending-editor-validation'};},async recover(){return transaction;},async validate(){validations++;return transaction={...transaction,state:'completed'};},async rollback(){rollbacks++;return transaction={...transaction,state:'pending-rollback-editor-validation'};}};
 const f=await setup(t,{executionService:execution}),initial=await f.prepare();await f.session.choose(initial.intentId,nameConflict(initial).id,'take-incoming');await f.session.apply(initial.intentId);assert.equal((await f.session.validate(initial.intentId)).state,'completed');assert.equal(validations,1);
 const newer=await f.prepare();assert.equal(newer.state,'blocked');await assert.rejects(f.session.rollback(initial.intentId),/review-locked/);await assert.rejects(f.session.validate(initial.intentId),/review-locked/);assert.equal(rollbacks,0);assert.equal(validations,1);assert.equal((await f.session.readIntent(initial.intentId)).state,'completed');
 await f.session.cancel(newer.intentId);assert.equal((await f.session.rollback(initial.intentId)).state,'pending-rollback-editor-validation');assert.equal(rollbacks,1);
});
