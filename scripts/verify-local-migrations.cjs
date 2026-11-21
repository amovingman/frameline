'use strict';
// Manual-code-upgrade/storage drill in newly created disposable directories.
// This neither installs an app nor opens the owner's actual workspace.
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const c = require('./local-migration-common.cjs');
async function child(root, stage) {
  root = await fs.realpath(root);
  c.need(path.basename(root).startsWith('frameline-local-migration-'), 'disposable-root-required');
  const f = JSON.parse(await c.read(path.join(root, 'fixture.json')));
  c.need(f.root === root && f.operation === 'disposable-local-schema-upgrade', 'fixture');
  const old = () => require(path.join(root, 'historical-reader/src/local-metadata.js'));
  const current = () => require('../src/local-metadata');
  const folder = name => path.join(root, name);
  const save = value => c.write(path.join(root, 'events', stage + '.json'), { stage, ...value });
  if (stage === 'bootstrap-old') {
    const store = old().createLocalMetadataStore(folder('base-workspace'));
    const manifest = await require(path.join(root, 'historical-reader/src/fcpxml-adapter.js')).scanFcpXml(f.exportPath);
    const project = await store.getProjectId(f.exportPath);
    const base = await store.saveRevision(project.id, manifest, 'Before upgrade');
    await store.createBranch(project.id, 'alternate', base.id);
    const alternate = await store.saveRevision(project.id, manifest, 'Alternate cut', base.id, 'alternate');
    await store.switchBranch(project.id, 'main');
    const head = await store.saveRevision(project.id, manifest, 'Main cut', base.id);
    await store.recordSyncBase(project.id, 'main', head.id, head.id);
    assert.equal((await c.metadata(folder('base-workspace'))).schemaVersion, 4);
    await save({ projectId: project.id, baseId: base.id, alternateId: alternate.id, headId: head.id,
      graph: await c.graph(folder('base-workspace')) });
    return;
  }
  const initial = JSON.parse(await c.read(path.join(root, 'events/bootstrap-old.json')));
  if (stage === 'upgrade' || stage.endsWith('-reopen')) {
    const name = stage === 'upgrade' ? 'normal-workspace' : stage.replace('-reopen', '-workspace');
    const store = current().createLocalMetadataStore(folder(name));
    assert.equal((await store.getProjectId(f.exportPath)).id, initial.projectId);
    await save({ graph: await c.graph(folder(name)), canonicalFiles: await c.canonicalTree(folder(name)) });
  } else if (stage === 'write-new') {
    const store = current().createLocalMetadataStore(folder('normal-workspace'));
    const manifest = await require('../src/fcpxml-adapter').scanFcpXml(f.exportPath);
    const revision = await store.saveRevision(initial.projectId, manifest, 'After upgrade', initial.headId);
    await save({ revisionId: revision.id, graph: await c.graph(folder('normal-workspace')) });
  } else if (stage === 'old-refuses') {
    const directory = folder('normal-workspace'), before = await c.canonicalTree(directory);
    assert.equal((await c.metadata(directory)).schemaVersion, 5);
    assert.equal(JSON.parse(await c.read(path.join(directory, 'metadata.json.bak'))).schemaVersion, 4);
    await assert.rejects(old().createLocalMetadataStore(directory).getProjectId(f.exportPath), { code: 'metadata-newer-version' });
    const after = await c.canonicalTree(directory); assert.deepEqual(after, before);
    await save({ error: 'metadata-newer-version', before, after, primarySchema: 5, backupSchema: 4 });
  } else if (stage === 'restore-old') {
    const before = await c.canonicalTree(folder('normal-workspace'));
    const store = old().createLocalMetadataStore(folder('restored-workspace'));
    assert.equal((await store.getProjectId(f.exportPath)).id, initial.projectId);
    assert.deepEqual(await c.graph(folder('restored-workspace')), initial.graph);
    assert.deepEqual(await c.canonicalTree(folder('normal-workspace')), before);
    await save({ graph: await c.graph(folder('restored-workspace')), newerWorkspacePreserved: true });
  } else if (stage === 'future-refuses') {
    const directory = folder('future-workspace'), before = await c.canonicalTree(directory);
    await assert.rejects(current().createLocalMetadataStore(directory).getProjectId(f.exportPath), { code: 'metadata-newer-version' });
    const after = await c.canonicalTree(directory); assert.deepEqual(after, before);
    await save({ error: 'metadata-newer-version', before, after, primarySchema: 6, backupSchema: 4 });
  } else if (stage === 'legacy-upgrade') {
    const store = current().createLocalMetadataStore(folder('legacy-workspace'));
    assert.equal((await store.getProjectId(f.exportPath)).id, initial.projectId);
    const index = await c.metadata(folder('legacy-workspace'));
    assert.equal(index.schemaVersion, 5);
    assert.equal(Object.values(index.projects)[0].revisions.length, 0);
    await save({ schemaVersion: 5, projectIdPreserved: true, revisions: 0 });
  } else if (stage === 'before' || stage === 'after') {
    const directory = folder(stage + '-workspace'); let reached = false;
    const storage = { ...fs, async rename(from, to) {
      await fs.rename(from, to);
      const target = stage === 'before' ? 'metadata.json.bak' : 'metadata.json';
      if (!reached && to === path.join(directory, target)) {
        reached = true;
        const evidence = { point: stage === 'before' ? 'backup-published-before-primary' : 'primary-replaced-before-acknowledgment',
          primarySchema: (await c.metadata(directory)).schemaVersion,
          primaryHash: c.sha(await c.read(path.join(directory, 'metadata.json'))),
          backupHash: c.sha(await c.read(path.join(directory, 'metadata.json.bak'))) };
        await save(evidence);
        process.send({ ready: true });
        await new Promise(() => {});
      }
    } };
    await current().createLocalMetadataStore(directory, { storage }).getProjectId(f.exportPath);
    throw Error('Expected actual process interruption');
  } else throw Error('Unknown migration stage');
}
async function invoke(root, stage, kill = false) {
  const env = { ...process.env, NODE_PATH: path.join(c.ROOT, 'node_modules') };
  delete env.NODE_OPTIONS;
  const proc = fork(__filename, ['--child', root, stage], { env, silent: true });
  let output = ''; proc.stdout.on('data', b => { output += b; }); proc.stderr.on('data', b => { output += b; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(Error('Local migration child timeout: ' + stage)); }, 30000);
    proc.once('error', error => { clearTimeout(timer); reject(error); });
    proc.on('message', value => { if (value.ready && kill) proc.kill('SIGKILL'); });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      try { assert.equal(signal, kill ? 'SIGKILL' : null, output); assert.equal(code, kill ? null : 0, output); resolve({ stage, code, signal }); }
      catch (error) { reject(error); }
    });
  });
}
async function runFixture({ directory } = {}) {
  const root = await fs.realpath(directory || await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-local-migration-')));
  c.need(path.basename(root).startsWith('frameline-local-migration-'), 'disposable-root-required');
  await fs.chmod(root, 0o700);
  const hashes = await c.codeHashes();
  const archived = await c.extract(c.ROOT, path.join(root, 'historical-reader'));
  const xml = gunzipSync(await fs.readFile(path.join(c.ROOT, 'phase-0/large-projects/corpus/small-editor.fcpxml.gz')));
  const parser = JSON.parse(await fs.readFile(path.join(c.ROOT, 'node_modules/fast-xml-parser/package.json')));
  const fixture = { operation: 'disposable-local-schema-upgrade', root, exportPath: path.join(root, 'timeline.fcpxml'), sourceHash: c.sha(xml),
    observedRuntime: { node: process.versions.node, platform: process.platform, architecture: process.arch,
      fastXmlParser: parser.version, parserEntrySha256: c.sha(await fs.readFile(require.resolve('fast-xml-parser'))),
      packageLockSha256: c.sha(await fs.readFile(path.join(c.ROOT, 'package-lock.json'))) } };
  await c.write(fixture.exportPath, xml); await c.write(path.join(root, 'fixture.json'), fixture);
  const processes = [await invoke(root, 'bootstrap-old')];
  for (const name of ['normal-workspace', 'before-workspace', 'after-workspace', 'restored-workspace', 'future-workspace']) {
    await c.copy(path.join(root, 'base-workspace'), path.join(root, name));
  }
  processes.push(await invoke(root, 'upgrade'), await invoke(root, 'old-refuses'), await invoke(root, 'write-new'));
  for (const point of ['before', 'after']) {
    processes.push(await invoke(root, point, true));
    await c.copy(path.join(root, point + '-workspace'), path.join(root, point + '-observed'));
    processes.push(await invoke(root, point + '-reopen'));
  }
  processes.push(await invoke(root, 'restore-old'));
  const future = await c.metadata(path.join(root, 'future-workspace')); future.schemaVersion = 6;
  await fs.writeFile(path.join(root, 'future-workspace/metadata.json'), JSON.stringify(future));
  await fs.writeFile(path.join(root, 'future-workspace/metadata.json.bak'), await c.read(path.join(root, 'base-workspace/metadata.json')));
  processes.push(await invoke(root, 'future-refuses'));
  const base = await c.metadata(path.join(root, 'base-workspace'));
  await fs.mkdir(path.join(root, 'legacy-workspace'), { mode: 0o700 });
  await c.write(path.join(root, 'legacy-workspace/metadata.json'), { schemaVersion: 1,
    projects: Object.fromEntries(Object.entries(base.projects).map(([key, project]) => [key, project.id])) });
  processes.push(await invoke(root, 'legacy-upgrade'));
  assert.equal(c.sha(await c.read(fixture.exportPath)), fixture.sourceHash);
  assert.deepEqual(await c.codeHashes(), hashes);
  await c.write(path.join(root, 'processes.json'), processes);
  const manifest = { schemaVersion: 1, files: await c.tree(root) };
  await c.write(path.join(root, 'manifest.json'), manifest);
  return { root, archived, sourceHashes: hashes, manifestSha256: c.sha(await c.read(path.join(root, 'manifest.json'))) };
}
async function main() {
  const run = await runFixture();
  const destination = path.join(c.ROOT, 'phase-0/private-integration-proof', path.basename(run.root));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }); await c.copy(run.root, destination);
  const { buildMigrationReceipt, auditLocalMigrations } = require('./audit-local-migrations.cjs');
  const receipt = await buildMigrationReceipt({ retentionDirectory: destination, sourceHashes: run.sourceHashes, manifestSha256: run.manifestSha256 });
  await fs.writeFile(path.join(c.ROOT, 'phase-0/local-migration-proof.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(await auditLocalMigrations()));
}
module.exports = { runFixture, invoke };
if (require.main === module) {
  const action = process.argv[2] === '--child' ? () => child(process.argv[3], process.argv[4]) : main;
  action().catch(error => { console.error(error); process.exitCode = 1; });
}
