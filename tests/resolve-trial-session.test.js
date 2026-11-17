'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createResolveReviewSession } = require('../src/resolve-review-session');
const { createResolveTrialSession } = require('../src/resolve-trial-session');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'resolve-trial-session-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const d = path.join(__dirname, '../phase-0/resolve-xml-proof');
  const local = await fs.readFile(path.join(d, 'live-rename-before-schema3.json'));
  const incoming = await fs.readFile(path.join(d, 'live-rename-applied-schema3.json'));
  const review = createResolveReviewSession({ artifactDirectory: path.join(root, 'reviews') });
  const sources = { base: local, local, incoming };
  review.load(sources);
  let copied = '';
  const clipboard = { readText: () => copied, writeText: value => { copied = value; } };
  const store = createLocalMetadataStore(path.join(root, 'metadata'));
  const options = { enabled: true, directory: path.join(root, 'trials'), store,
    clipboard, getReview: async () => review.getVerifiedReview(sources) };
  return { root, sources, review, options, session: createResolveTrialSession(options) };
}

async function fakeExport(directory) {
  for (const name of ['project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml']) {
    const filename = path.join(directory, name);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, '<Fixture/>');
  }
  assert.equal(spawnSync('zip', ['-q', path.join(directory, 'before.drp'), 'project.xml', 'MediaPool/Master/MpFolder.xml', 'SeqContainer/timeline.xml'], { cwd: directory }).status, 0);
}

test('desktop drill session binds review, gates stages, sanitizes state, and saves/reloads a verified history link', async t => {
  const { session, options, sources } = await setup(t);
  assert.ok((await session.prepare('Frameline Restore Probe', false)).error);
  assert.equal((await session.prepare('Frameline Restore Probe', true)).phase, 'backup-command');
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  await fakeExport(folder);
  const issued = await session.issue();
  assert.equal(issued.phase, 'rollback-command');
  assert.equal(issued.backup.archiveVerified, true);
  assert.ok(!JSON.stringify(issued).includes(folder));
  assert.equal(issued.command, undefined);
  assert.match(options.clipboard.readText(), /Intentional trial failure/);
  const before = sources.local.toString('utf8').trimEnd();
  const chunks = [];
  for (let n = 0; n < before.length; n += 8192) chunks.push(`FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${issued.transactionId}:${chunks.length + 1}:${before.slice(n, n + 8192)}`);
  options.clipboard.writeText([...chunks, `FRAMELINE_RENAME_TRIAL_RESULT_V1:${issued.transactionId}:rolled-back`].join('\n'));
  assert.equal((await session.read()).phase, 'verified');
  const saved = await session.saveRevision();
  assert.equal(saved.phase, 'saved');
  assert.ok(saved.revisionId);
  assert.equal(await session.backupPath(), path.join(folder, 'before.drp'));
  const restarted = createResolveTrialSession(options);
  assert.equal((await restarted.recover(folder)).phase, 'verified');
  assert.equal((await restarted.saveRevision()).revisionId, saved.revisionId);
  const project = await options.store.getResolveProjectId(JSON.parse(sources.local).project_id);
  assert.equal((await options.store.listRevisions(project.id)).length, 2);
});

test('disabled sessions expose no commands and source changes prevent issuance', async t => {
  const { options, session, sources, review } = await setup(t);
  const disabled = createResolveTrialSession({ ...options, enabled: false });
  assert.equal((await disabled.prepare('Frameline Restore Probe', true)).enabled, false);
  assert.equal(options.clipboard.readText(), '');
  await session.prepare('Frameline Restore Probe', true);
  sources.local = Buffer.concat([sources.local, Buffer.from('\n')]);
  assert.throws(() => review.getVerifiedReview(sources));
  const blocked = await session.issue();
  assert.equal(blocked.phase, 'backup-command');
  assert.match(blocked.error, /Sources changed/);
});

test('concurrent desktop actions do not issue a second transaction', async t => {
  const { options } = await setup(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const getReview = options.getReview;
  const session = createResolveTrialSession({ ...options, getReview: async () => { await gate; return getReview(); } });
  const preparing = session.prepare('Frameline Restore Probe', true);
  assert.match((await session.prepare('Frameline Restore Probe', true)).error, /already running/);
  release();
  assert.equal((await preparing).phase, 'backup-command');
  assert.equal((await fs.readdir(options.directory)).length, 1);
});

test('backup preparation can be cancelled while retaining records and without exposing a mutation command', async t => {
  const { session, options } = await setup(t);
  await session.prepare('Frameline Restore Probe', true);
  const folder = path.join(options.directory, (await fs.readdir(options.directory))[0]);
  assert.equal((await session.cancelPreparation()).phase, 'idle');
  assert.ok((await fs.stat(path.join(folder, 'cancelled.json'))).isFile());
  assert.ok((await session.copyCommand()).error);
  assert.equal((await session.prepare('Frameline Restore Probe', true)).phase, 'backup-command');
});
