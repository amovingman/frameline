'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createResolvePreviewPlan } = require('../../src/resolve-preview-plan');
const { createResolveDecisionAudit } = require('../../src/resolve-review-decisions');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const trackId = '00000000-0000-4000-8000-000000000001';
const sequenceId = '00000000-0000-4000-8000-000000000002';
async function closedProjectFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'closed-project-adapter-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = JSON.parse(await fs.readFile(path.join(__dirname, '../../phase-0/resolve-xml-proof/live-rename-before-schema3.json')));
  const timeline = local.timelines.find(value => value.items.some(item => item.type === 'video'));
  const item = timeline.items.find(value => value.type === 'video');
  item.name = 'Stored custom Name';
  const incoming = structuredClone(local);
  incoming.timelines.find(value => value.id === timeline.id).items.find(value => value.id === item.id).name = 'Reviewed new Name';
  const sources = { base: Buffer.from(JSON.stringify(local)), local: Buffer.from(JSON.stringify(local)), incoming: Buffer.from(JSON.stringify(incoming)) };
  const plan = createResolvePreviewPlan(sources), audit = createResolveDecisionAudit(plan, sources, []);
  const sourceDirectory = path.join(root, local.project_name); await fs.mkdir(sourceDirectory, { mode: 0o700 });
  const sourcePath = path.join(sourceDirectory, 'Project.db');
  const fixture = { projectId: local.project_id, projectName: local.project_name, timelineId: timeline.id, itemId: item.id, trackId, sequenceId, oldName: item.name };
  execFileSync('python3', ['-B', '-c', `
import sqlite3,sys,json,os
v=json.loads(sys.argv[2]);c=sqlite3.connect(sys.argv[1])
c.executescript('CREATE TABLE SM_Project(SM_Project_id TEXT PRIMARY KEY,ProjectName TEXT,DbType TEXT);CREATE TABLE Sm2TiItem(Sm2TiItem_id TEXT PRIMARY KEY,Name TEXT,DbType TEXT,Sm2TiTrack_id TEXT,Flags INTEGER,Unknown BLOB);CREATE TABLE Sm2TiTrack(Sm2TiTrack_id TEXT PRIMARY KEY,DbType TEXT,Type INTEGER,Sequence TEXT);CREATE TABLE Sm2Timeline(Sm2Timeline_id TEXT PRIMARY KEY,DbType TEXT,Sequence TEXT,SM_Project_id TEXT);CREATE TABLE Sm2Sequence(Sm2Sequence_id TEXT PRIMARY KEY,DbType TEXT,Parent TEXT);CREATE TABLE OpaqueRows(value BLOB,raw TEXT);')
c.execute('INSERT INTO SM_Project VALUES(?,?,?)',(v['projectId'],v['projectName'],'SM_Project'))
c.execute('INSERT INTO Sm2TiItem VALUES(?,?,?,?,?,?)',(v['itemId'],v['oldName'],'Sm2TiVideoClip',v['trackId'],7,bytes.fromhex('00ff7f')))
c.execute('INSERT INTO Sm2TiTrack VALUES(?,?,?,?)',(v['trackId'],'Sm2TiTrack',0,v['sequenceId']))
c.execute('INSERT INTO Sm2Timeline VALUES(?,?,?,?)',(v['timelineId'],'Sm2Timeline',v['sequenceId'],v['projectId']))
c.execute('INSERT INTO Sm2Sequence VALUES(?,?,?)',(v['sequenceId'],'Sm2Sequence',v['timelineId']))
c.execute("INSERT INTO OpaqueRows VALUES(x'00ff',CAST(x'fffe0061' AS TEXT))")
c.execute("INSERT INTO OpaqueRows SELECT * FROM OpaqueRows")
c.commit();c.close();os.chmod(sys.argv[1],0o600)
`, sourcePath, JSON.stringify(fixture)], { stdio: ['ignore', 'pipe', 'pipe'] });
  async function directory(name) { const value = path.join(root, name); await fs.mkdir(value, { mode: 0o700 }); return value; }
  const metadata = { mode: 0o600, uid: process.getuid(), gid: process.getgid(), flags: 0, aclEntries: [], extendedAttributes: [], exactPreservationRequired: true };
  const guard = {
    async inspect({ sourcePath: source, expectedSourceHash }) {
      const bytes = await fs.readFile(source), stat = await fs.stat(source);
      if (expectedSourceHash && sha(bytes) !== expectedSourceHash) throw new Error('fixture-source-hash-stale');
      return { schemaVersion: 1, sourcePath: source, sha256: sha(bytes), size: bytes.length,
        identity: { device: String(stat.dev), inode: String(stat.ino), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
        directoryIdentity: {}, metadata: structuredClone(metadata), installedBuild: { version: 'test-only' }, freshObservationOnly: true, safeToApply: false };
    }
  };
  return { root, sourcePath, directory, review: { sources, plan, audit }, fixture, guard, metadata };
}
module.exports = { closedProjectFixture, sha };
