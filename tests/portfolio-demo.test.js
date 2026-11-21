const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPortfolioDemo, formatTranscript } = require('../scripts/portfolio-demo.cjs');
const { createLocalMetadataStore } = require('../src/local-metadata');

test('public demo reproduces its transcript with real scans and reopened immutable history', async () => {
  const result = await runPortfolioDemo();
  assert.deepEqual(result.comparison.changes, [
    { kind: 'sequence', name: 'name', before: 'Edit before', after: 'Edit after' },
    { kind: 'sequence', name: 'durationFrames', before: 144, after: 120 },
    { kind: 'media', name: 'inserted.mov', before: null, after: 'unknown' },
    { kind: 'media', name: 'removed.mov', before: 'unknown', after: null }
  ]);
  assert.equal(result.comparison.clipChangesAvailable, false);
  assert.equal(result.comparison.mediaIdentityAvailable, false);
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.equal(Object.hasOwn(result, 'workspace'), false);
  const transcript = await fs.readFile(path.join(__dirname, '..', 'docs', 'demo', 'transcript.txt'), 'utf8');
  assert.equal(formatTranscript(result), transcript);
  assert.doesNotMatch(transcript, /\/Users\/|\/private\/|frameline-portfolio-[a-zA-Z0-9]+/);
});

test('retained demo folder contains inspectable source copies and two linked production records', async () => {
  const result = await runPortfolioDemo({ keepWorkspace: true });
  try {
    assert.match(path.basename(result.workspace), /^frameline-portfolio-/);
    const store = createLocalMetadataStore(path.join(result.workspace, 'history'));
    const project = await store.getProjectId(path.join(result.workspace, 'timeline.fcpxml'));
    const revisions = await store.listRevisions(project.id);
    assert.deepEqual(revisions.map(item => item.message), ['Shorter cut', 'First cut']);
    assert.equal(revisions[0].parentRevisionId, revisions[1].id);
    const fixture = await fs.readFile(path.join(result.workspace, 'edit-after.fcpxml'));
    assert.deepEqual(await fs.readFile(path.join(result.workspace, 'timeline.fcpxml')), fixture);
  } finally {
    await fs.rm(result.workspace, { recursive: true, force: true });
  }
});

test('demo rejects unknown flags before creating a workspace', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'portfolio-demo.cjs'), '--delete'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Usage:/);
});
