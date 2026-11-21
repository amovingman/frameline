'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { closedProjectFixture, sha } = require('./helpers/closed-project-apply-fixture');
const native = require('../src/closed-project-native-store');
const { readProjectIdentity } = require('../src/native-project-identity');
const { createClosedProjectCheckpointStore } = require('../src/closed-project-checkpoint-store');
async function setup(t) {
 const f = await closedProjectFixture(t); const bindingFor = sourcePath => ({ schemaVersion: 1, sourcePath, projectName: f.fixture.projectName,
  libraryRoot: path.dirname(path.dirname(sourcePath)), configSha256: sha('configured libraries'), expectedCurrentDatabase: { DbType: 'Disk', DbName: path.basename(path.dirname(path.dirname(sourcePath))) }, expectedCurrentFolder: 'Root' });
 const options = { directory: path.join(f.root, 'identity-store'), guard: f.guard, nativeStore: { ...native, readProjectIdentity },
  sourceBindingService: { async prepareClosedProjectSourceBinding({ sourcePath }) { return bindingFor(sourcePath); } } };
 const store = createClosedProjectCheckpointStore(options);
 const capture = (extras = {}) => store.capture({ sourcePath: f.sourcePath, ...extras });
 function sql(query, params = [], source = f.sourcePath) { execFileSync('python3', ['-B', '-c', 'import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);c.execute(sys.argv[2],json.loads(sys.argv[3]));c.commit();c.close()', source, query, JSON.stringify(params)]); }
 return { ...f, options, store, capture, sql, bindingFor };
}
const entity = (record, kind, nativeId) => record.entities.find(e => e.kind === kind && (!nativeId || e.nativeId === nativeId));
test('real native checkpoints retain generated IDs across field edits, names, restart and byte reversion', async t => {
 const f = await setup(t), initial = await f.capture(); assert.equal(initial.projectId, f.fixture.projectId); assert.equal(initial.scope.projectPath, f.sourcePath);
 assert.equal(initial.entities.length, 5); assert.equal(initial.safeToApply, false); assert.equal(initial.currentUnsavedIdentityProven, false);
 const before = await f.store.readCheckpoint(initial.checkpointId); assert.equal(sha(before.databaseBytes), initial.source.sha256);
 const repeated = await f.capture(); assert.equal(repeated.checkpointId, initial.checkpointId); assert.equal((await f.store.list()).length, 1);
 f.sql('UPDATE Sm2TiItem SET Name=?, Flags=? WHERE Sm2TiItem_id=?', ['Another Name', 8, f.fixture.itemId]);
 const changed = await f.capture({ parentCheckpointId: initial.checkpointId }); assert.equal(changed.parentCheckpointId, initial.checkpointId); assert.notEqual(changed.source.sha256, initial.source.sha256);
 assert.deepEqual(changed.entities.map(e => e.appId), initial.entities.map(e => e.appId));
 const restarted = createClosedProjectCheckpointStore(f.options); assert.equal((await restarted.inspect(changed.checkpointId)).projectAppId, initial.projectAppId);
 assert.equal(await restarted.isAncestor(initial.checkpointId, changed.checkpointId), true); assert.equal(await restarted.isAncestor(changed.checkpointId, initial.checkpointId), false);
 await fs.writeFile(f.sourcePath, before.databaseBytes); const reverted = await restarted.capture({ sourcePath: f.sourcePath });
 assert.equal(reverted.source.sha256, initial.source.sha256); assert.notEqual(reverted.checkpointId, initial.checkpointId); assert.equal(reverted.parentCheckpointId, changed.checkpointId);
 assert.equal(entity(reverted, 'item').appId, entity(initial, 'item').appId);
});
test('observed deletion and recreation creates a new ID generation rather than resurrecting identity', async t => {
 const f = await setup(t), before = await f.capture(); f.sql('DELETE FROM Sm2TiItem WHERE Sm2TiItem_id=?', [f.fixture.itemId]); const absent = await f.capture();
 assert.equal(entity(absent, 'item'), undefined); let ledger = await f.store.getIdentityLedger(before.lineageId); assert.equal(ledger.entries[`item:${f.fixture.itemId}`].active, false);
 f.sql('INSERT INTO Sm2TiItem VALUES(?,?,?,?,?,?)', [f.fixture.itemId, f.fixture.oldName, 'Sm2TiVideoClip', f.fixture.trackId, 7, null]);
 const recreated = await f.capture(); assert.equal(entity(recreated, 'item').generation, 2); assert.notEqual(entity(recreated, 'item').comparisonId, entity(before, 'item').comparisonId); assert.notEqual(entity(recreated, 'item').appId, entity(before, 'item').appId);
 assert.equal(entity(recreated, 'track').appId, entity(before, 'track').appId); ledger = await f.store.getIdentityLedger(before.lineageId); assert.equal(ledger.entries[`item:${f.fixture.itemId}`].active, true);
});
test('moving an item between native tracks retains item ID and updates its parent by UUID', async t => {
 const f = await setup(t), before = await f.capture(), other = '00000000-0000-4000-8000-000000000009';
 f.sql('INSERT INTO Sm2TiTrack VALUES(?,?,?,?)', [other, 'Sm2TiTrack', 0, f.fixture.sequenceId]); f.sql('UPDATE Sm2TiItem SET Sm2TiTrack_id=? WHERE Sm2TiItem_id=?', [other, f.fixture.itemId]);
 const moved = await f.capture(); assert.equal(entity(moved, 'item').appId, entity(before, 'item').appId); assert.equal(entity(moved, 'item').parentNativeId, other);
 assert.equal(entity(moved, 'item').parentAppId, entity(moved, 'track', other).appId);
});
test('unrelated library copies do not share generated IDs or comparison ancestry', async t => {
 const f = await setup(t), before = await f.capture(), other = await f.directory('other-library'), project = path.join(other, f.fixture.projectName); await fs.mkdir(project, { mode: 0o700 });
 const sourcePath = path.join(project, 'Project.db'); await fs.copyFile(f.sourcePath, sourcePath); await fs.chmod(sourcePath, 0o600);
 const copied = await f.store.capture({ sourcePath }); assert.equal(copied.projectId, before.projectId); assert.notEqual(copied.lineageId, before.lineageId); assert.notEqual(copied.projectAppId, before.projectAppId);
 assert.notEqual(copied.comparisonRootLineageId, before.comparisonRootLineageId); assert.equal(await f.store.isAncestor(before.checkpointId, copied.checkpointId), false);
});
test('a trusted completed copy transaction establishes an explicit fork without sharing library app IDs', async t => {
 const f = await setup(t); await f.capture(); f.sql('DELETE FROM Sm2TiItem WHERE Sm2TiItem_id=?', [f.fixture.itemId]); await f.capture(); f.sql('INSERT INTO Sm2TiItem VALUES(?,?,?,?,?,?)', [f.fixture.itemId, f.fixture.oldName, 'Sm2TiVideoClip', f.fixture.trackId, 7, null]); const before = await f.capture(), other = await f.directory('copy-library'), project = path.join(other, f.fixture.projectName); assert.equal(entity(before, 'item').generation, 2); await fs.mkdir(project, { mode: 0o700 });
 const sourcePath = path.join(project, 'Project.db'); await fs.copyFile(f.sourcePath, sourcePath); await fs.chmod(sourcePath, 0o600); f.sql('UPDATE Sm2TiItem SET Name=?', ['Copied Name'], sourcePath);
 const tx = '00000000-0000-4000-8000-000000000010', copiedSha = sha(await fs.readFile(sourcePath)); let transaction = { state: 'completed', transactionId: tx, plan: { projectId: before.projectId }, original: { path: f.sourcePath, sha256: before.source.sha256 },
  destination: { path: sourcePath, libraryRoot: other, binding: f.bindingFor(sourcePath) }, candidate: { sha256: copiedSha }, editorProof: { verified: true, closed: true, actualOpenFileBindingVerified: true, sourceSha256: copiedSha, proofSha256: sha('verified native proof') } };
 const store = createClosedProjectCheckpointStore({ ...f.options, verifyCopyLineage: async args => { assert.equal(args.sourceRecord.checkpointId, before.checkpointId); return transaction; } });
 const fork = await store.capture({ sourcePath, lineage: { transactionId: tx, sourceCheckpointId: before.checkpointId } });
 assert.equal(fork.forkParentCheckpointId, before.checkpointId); assert.equal(fork.comparisonRootLineageId, before.comparisonRootLineageId); assert.notEqual(fork.projectAppId, before.projectAppId); assert.equal(entity(fork, 'item').comparisonId, entity(before, 'item').comparisonId);
 assert.equal(await store.isAncestor(before.checkpointId, fork.checkpointId), true); assert.equal(fork.copyTransactionId, tx);
 f.sql('UPDATE Sm2TiItem SET Flags=22', [], sourcePath); const next = await store.capture({ sourcePath }); assert.equal(next.parentCheckpointId, fork.checkpointId); assert.equal(next.comparisonRootLineageId, before.comparisonRootLineageId);
});
test('fork assertions, stale parent and invalid UUID parentage are refused', async t => {
 const f = await setup(t), before = await f.capture(); f.sql('UPDATE Sm2TiItem SET Name=?', ['Changed']); const changed = await f.capture();
 await assert.rejects(f.capture({ parentCheckpointId: before.checkpointId }), /parent-stale/);
 await assert.rejects(f.capture({ lineage: { transactionId: '00000000-0000-4000-8000-000000000010', sourceCheckpointId: before.checkpointId } }), /copy-lineage-required/);
 f.sql('UPDATE Sm2TiItem SET Sm2TiTrack_id=?', ['00000000-0000-4000-8000-000000000099']); await assert.rejects(f.capture(), /item-parent-invalid/);
 assert.equal((await f.store.list()).length, 2); assert.equal((await f.store.inspect(changed.checkpointId)).checkpointId, changed.checkpointId);
});
test('tampered census artifacts and authenticated identity journal changes never become valid checkpoints', async t => {
 const f = await setup(t), captured = await f.capture(); const census = path.join(f.options.directory, 'checkpoints', captured.checkpointId, 'capture/source.db.census.json');
 await fs.appendFile(census, ' '); await assert.rejects(f.store.readCheckpoint(captured.checkpointId), /artifact-changed/);
 const state = path.join(f.options.directory, 'state-000000.json'), value = JSON.parse(await fs.readFile(state)); value.body = value.body.replace(captured.projectAppId, '00000000-0000-4000-8000-000000000099'); await fs.writeFile(state, JSON.stringify(value));
 await assert.rejects(createClosedProjectCheckpointStore(f.options).list(), /authentication-invalid/);
});
test('source changes and metadata/library drift fail current checkpoint verification', async t => {
 const f = await setup(t), before = await f.capture(); assert.equal((await f.store.verifyCurrent(before.checkpointId)).sha256, before.source.sha256);
 f.sql('UPDATE Sm2TiItem SET Flags=11'); await assert.rejects(f.store.verifyCurrent(before.checkpointId), /source-hash-stale/);
 const altered = createClosedProjectCheckpointStore({ ...f.options, sourceBindingService: { async prepareClosedProjectSourceBinding({ sourcePath }) { return { ...f.bindingFor(sourcePath), configSha256: sha('different configuration') }; } } });
 await assert.rejects(altered.verifyCurrent(before.checkpointId), /source-library-changed/);
});
test('record-before-index interruption leaves no partial identity authority and committed state recovers after restart', async t => {
 const f = await setup(t); let stage = 'record-retained';
 const interrupted = createClosedProjectCheckpointStore({ ...f.options, onCheckpoint: async name => { if (name === stage) throw Error('simulated interruption'); } });
 await assert.rejects(interrupted.capture({ sourcePath: f.sourcePath }), /simulated interruption/); assert.equal((await f.store.list()).length, 0);
 stage = 'state-committed'; await assert.rejects(interrupted.capture({ sourcePath: f.sourcePath }), /simulated interruption/); const records = await f.store.list(); assert.equal(records.length, 1);
 assert.equal((await f.store.readCheckpoint(records[0].checkpointId)).record.checkpointId, records[0].checkpointId);
});
test('actual process death after committed identity state recovers the same generated IDs without replay', async t => {
 const f = await setup(t), child = path.join(f.root, 'crash-capture.cjs');
 await fs.writeFile(child, `
 const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
 const sha=b=>createHash('sha256').update(b).digest('hex'),root=${JSON.stringify(f.root)},sourcePath=${JSON.stringify(f.sourcePath)},context=${JSON.stringify(f.fixture)},metadata=${JSON.stringify(f.metadata)};
 const guard={async inspect({sourcePath,expectedSourceHash}){const b=await fs.readFile(sourcePath),s=await fs.stat(sourcePath);if(expectedSourceHash&&sha(b)!==expectedSourceHash)throw Error('stale');return{schemaVersion:1,sourcePath,sha256:sha(b),size:b.length,identity:{device:String(s.dev),inode:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs},directoryIdentity:{},metadata,installedBuild:{version:'test-only'},freshObservationOnly:true,safeToApply:false};}};
 const binding=${JSON.stringify(f.bindingFor(f.sourcePath))};
 const store=require(${JSON.stringify(path.resolve(__dirname,'../src/closed-project-checkpoint-store.js'))}).createClosedProjectCheckpointStore({directory:${JSON.stringify(f.options.directory)},guard,sourceBindingService:{async prepareClosedProjectSourceBinding(){return binding;}},onCheckpoint:async stage=>{if(stage==='state-committed')process.exit(73);}});
 store.capture({sourcePath,projectId:context.projectId,projectName:context.projectName}).catch(e=>{console.error(e);process.exit(1);});
 `, { mode: 0o600 });
 assert.throws(() => execFileSync(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status === 73);
 const retained = await f.store.list(); assert.equal(retained.length, 1); const same = await f.capture();
 assert.equal(same.checkpointId, retained[0].checkpointId); assert.equal(same.projectAppId, retained[0].projectAppId); assert.equal((await f.store.list()).length, 1);
});
test('native type reuse and unverified lineage receipts cannot replace previously retained identity authority', async t => {
 const f = await setup(t), before = await f.capture(); f.sql('UPDATE Sm2TiItem SET DbType=?', ['Sm2TiAudioClip']);
 await assert.rejects(f.capture(), /native-type-reused/); assert.equal((await f.store.list()).length, 1);
 await assert.rejects(f.store.isAncestor('00000000-0000-4000-8000-000000000099','00000000-0000-4000-8000-000000000099'), /not-found/);
 assert.equal((await f.store.inspect(before.checkpointId)).projectAppId, before.projectAppId);
});
