'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createProjectPresetIntents } = require('../src/project-preset-intents');
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const save = () => ({ kind: 'save', input: { teamId: 'team', presetId: null, expectedVersion: 0,
  name: 'Été documentary', branches: ['edit', 'review'], syncClasses: ['audio', 'proxy'] }, plan: null });
const create = () => ({ kind: 'create', input: { teamId: 'team', presetId: 'template', expectedVersion: 2,
  projectName: 'Disposable film', planId: 'c'.repeat(64) }, plan: { planId: 'c'.repeat(64), teamId: 'team', presetId: 'template',
  presetVersion: 2, projectName: 'Disposable film', branches: ['main', 'edit'], syncClasses: ['audio'], mediaAvailable: true } });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'preset-intents-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'intents');
  return { root, directory, filename: path.join(directory, 'presets-intents.json'),
    store: createProjectPresetIntents({ directory, now: () => 1000 }) };
}
const ioError = () => Object.assign(new Error('/private/untrusted IO detail'), { code: 'EIO' });

test('pending save/create identities survive restart exactly, isolate accounts, and require explicit matching completion', async t => {
  const { directory, filename, store } = await fixture(t);
  assert.equal(await store.load(A), null);
  const first = await store.begin(A, save()); assert.equal(first.created, true); assert.equal(first.record.createdAt, 1000);
  assert.notEqual(first.record.id, first.record.input.idempotencyKey);
  assert.deepEqual(await store.begin(A, save()), { created: false, record: first.record });
  const reopened = createProjectPresetIntents({ directory }); assert.deepEqual(await reopened.load(A), first.record);
  const other = await reopened.begin(B, create()); assert.equal(other.created, true); assert.notEqual(other.record.id, first.record.id);
  other.record.plan.branches.push('mutated'); assert.deepEqual((await store.load(B)).plan.branches, ['main', 'edit']);
  await assert.rejects(store.begin(A, { ...save(), input: { ...save().input, name: 'Different intent' } }), { code: 'project-presets-retry-required' });
  await assert.rejects(store.begin(A, create()), { code: 'project-presets-retry-required' });
  await assert.rejects(store.complete(A, randomUUID()), { code: 'project-presets-selection-changed' });
  assert.deepEqual(await store.complete(A, first.record.id), { removed: true });
  assert.deepEqual(await store.complete(A, first.record.id), { removed: false });
  assert.equal(await reopened.load(A), null); assert.equal((await reopened.load(B)).id, other.record.id);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700); assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(directory, 'initialized.json'))).mode & 0o777, 0o600);
});

test('invalid or substituted intent/plan fails before creating state or retaining credentials', async t => {
  const { directory, store } = await fixture(t);
  for (const value of [{ ...save(), kind: 'unknown' }, { ...save(), plan: {} },
    { ...save(), input: { ...save().input, idempotencyKey: 'caller-key' } },
    { ...save(), input: { ...save().input, password: 'never store me' } },
    { ...create(), plan: { ...create().plan, projectName: 'Other name' } },
    { ...create(), plan: { ...create().plan, planId: 'd'.repeat(64) } },
    { ...create(), input: { ...create().input, expectedVersion: 3 } },
    { ...create(), plan: { ...create().plan, branches: ['edit', 'main'] } }]) {
    await assert.rejects(store.begin(A, value), { code: 'project-presets-intent-invalid' });
  }
  await assert.rejects(store.load('not-binding'), { code: 'project-presets-intent-invalid' });
  await assert.rejects(store.complete(A, 'not-uuid'), { code: 'project-presets-intent-invalid' });
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('cooperating factories serialize concurrent identical intents and never lose other account updates', async t => {
  const { directory, store } = await fixture(t), other = createProjectPresetIntents({ directory });
  const results = await Promise.all([store.begin(A, save()), other.begin(A, save()), store.begin(B, create())]);
  assert.equal(results[0].record.id, results[1].record.id); assert.equal(results.filter(v => v.created).length, 2);
  assert.equal((await other.load(B)).id, results[2].record.id);
  const different = await Promise.allSettled([store.complete(A, results[0].record.id), other.begin(A, create())]);
  assert.equal(different[0].status, 'fulfilled');
  if (different[1].status === 'rejected') assert.equal(different[1].reason.code, 'project-presets-retry-required');
  assert.equal((await other.load(B)).id, results[2].record.id);
});

test('unknown schemas, corruption, unsafe permissions, symlinks, hardlinks and oversize files fail closed', async t => {
  const { root, directory, filename, store } = await fixture(t); await store.begin(A, save());
  const good = await fs.readFile(filename);
  for (const bytes of [Buffer.from('{bad'), Buffer.from('{"schemaVersion":2,"entries":[]}'), Buffer.from([0xff]),
    Buffer.from(JSON.stringify({ ...JSON.parse(good), unknown: true })), Buffer.alloc(2 * 1024 * 1024 + 1, 32)]) {
    await fs.writeFile(filename, bytes); await assert.rejects(createProjectPresetIntents({ directory }).load(A), { code: 'project-presets-intent-invalid' });
  }
  await fs.writeFile(filename, good); await fs.chmod(filename, 0o644);
  await assert.rejects(store.load(A), { code: 'project-presets-intent-invalid' }); await fs.chmod(filename, 0o600);
  await fs.chmod(directory, 0o755); await assert.rejects(store.load(A), { code: 'project-presets-intent-invalid' }); await fs.chmod(directory, 0o700);
  const privateCopy = path.join(root, 'copy'); await fs.writeFile(privateCopy, good, { mode: 0o600 });
  await fs.unlink(filename); await fs.symlink(privateCopy, filename);
  await assert.rejects(createProjectPresetIntents({ directory }).load(A)); await fs.unlink(filename); await fs.link(privateCopy, filename);
  await assert.rejects(createProjectPresetIntents({ directory }).load(A), { code: 'project-presets-intent-invalid' });
  const alias = path.join(root, 'alias'); await fs.symlink(directory, alias);
  await assert.rejects(createProjectPresetIntents({ directory: alias }).load(A), { code: 'project-presets-intent-invalid' });
});

test('a missing used journal refuses silent reset in both existing and fresh factories', async t => {
  const { directory, filename, store } = await fixture(t); await store.begin(A, save()); await fs.unlink(filename);
  await assert.rejects(store.load(A), { code: 'project-presets-intent-invalid' });
  await assert.rejects(createProjectPresetIntents({ directory }).begin(A, save()), { code: 'project-presets-intent-invalid' });
  await assert.rejects(fs.stat(filename), { code: 'ENOENT' });
});

test('pre-publication flush failure retains old state and permits retry with no false acknowledgment', async t => {
  const { directory, filename, store } = await fixture(t); const first = await store.begin(A, save()); const before = await fs.readFile(filename);
  let failing = true;
  const storage = { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.tmp')) return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => { if (failing) throw ioError(); return target.sync(); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
    return handle;
  } };
  const failingStore = createProjectPresetIntents({ directory, storage });
  await assert.rejects(failingStore.begin(B, create()), error => error.code === 'project-presets-intent-storage-unavailable' && error.message === error.code);
  assert.deepEqual(await fs.readFile(filename), before); assert.deepEqual(await failingStore.load(A), first.record);
  failing = false; assert.equal((await failingStore.begin(B, create())).created, true);
});

test('a rename that publishes then reports failure latches uncertain and a fresh factory recovers the exact key', async t => {
  const { directory, filename, store } = await fixture(t); await store.load(A);
  const storage = { ...fs, rename: async (...args) => { await fs.rename(...args); throw ioError(); } };
  const failingStore = createProjectPresetIntents({ directory, storage });
  await assert.rejects(failingStore.begin(A, create()), { code: 'project-presets-intent-storage-uncertain' });
  await assert.rejects(failingStore.load(A), { code: 'project-presets-intent-storage-uncertain' });
  await assert.rejects(failingStore.complete(A, randomUUID()), { code: 'project-presets-intent-storage-uncertain' });
  const saved = JSON.parse(await fs.readFile(filename, 'utf8')).entries[0].record;
  const reopened = createProjectPresetIntents({ directory });
  assert.deepEqual(await reopened.load(A), saved); assert.deepEqual(await reopened.begin(A, create()), { created: false, record: saved });
});

test('directory flush failure after publication refuses ACK and no directory symlink can create escaped state', async t => {
  const { root, directory, store } = await fixture(t); await store.load(A);
  let published = false;
  const storage = { ...fs, rename: async (...args) => { await fs.rename(...args); published = true; }, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] === directory) return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => { if (published) throw ioError(); return target.sync(); };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }); return handle;
  } };
  const failingStore = createProjectPresetIntents({ directory, storage });
  await assert.rejects(failingStore.begin(A, save()), { code: 'project-presets-intent-storage-uncertain' });
  assert((await createProjectPresetIntents({ directory }).load(A)).id);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside, { mode: 0o700 }); const alias = path.join(root, 'aliased-parent'); await fs.symlink(outside, alias);
  await assert.rejects(createProjectPresetIntents({ directory: path.join(alias, 'escape') }).load(A), { code: 'project-presets-intent-invalid' });
  assert.deepEqual(await fs.readdir(outside), []);
});

test('the account bound and persisted UUID/plan bindings are validated without discarding existing pending work', async t => {
  const { directory, filename, store } = await fixture(t); await store.load(A);
  const entries = Array.from({ length: 100 }, (_, index) => {
    const id = randomUUID(), value = save();
    return { bindingHash: index.toString(16).padStart(64, '0'), record: { id, kind: value.kind,
      input: { ...value.input, idempotencyKey: randomUUID() }, plan: null, createdAt: 0 } };
  });
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, entries })); await fs.writeFile(filename, bytes);
  assert.equal((await store.load(entries[0].bindingHash)).id, entries[0].record.id);
  await assert.rejects(store.begin(A, create()), { code: 'project-presets-intent-invalid' });
  assert.deepEqual(await fs.readFile(filename), bytes);
  for (const bad of [
    { schemaVersion: 1, entries: [entries[0], entries[0]] },
    { schemaVersion: 1, entries: [{ ...entries[0], record: { ...entries[0].record, input: { ...entries[0].record.input, idempotencyKey: entries[0].record.id } } }] },
    { schemaVersion: 1, entries: [{ ...entries[0], record: { ...entries[0].record, createdAt: 8_640_000_000_000_001 } }] }
  ]) {
    await fs.writeFile(filename, JSON.stringify(bad));
    await assert.rejects(createProjectPresetIntents({ directory }).load(entries[0].bindingHash), { code: 'project-presets-intent-invalid' });
  }
});

test('a FIFO substituted for the private journal is rejected without waiting for a writer', async t => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const { directory, filename, store } = await fixture(t); await store.load(A); await fs.unlink(filename);
  execFileSync('mkfifo', ['-m', '600', filename]);
  const program = `const {createProjectPresetIntents}=require(process.argv[1]);let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',async()=>{try{await createProjectPresetIntents({directory:JSON.parse(text).directory}).load('${A}');process.exitCode=2;}catch(e){if(e.code!=='project-presets-intent-invalid')process.exitCode=3;}});`;
  const child = spawnSync(process.execPath, ['-e', program, path.resolve(__dirname, '../src/project-preset-intents.js')],
    { input: JSON.stringify({ directory }), timeout: 2000, encoding: 'utf8' });
  assert.equal(child.error?.code, undefined); assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
});
