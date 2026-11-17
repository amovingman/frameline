const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAdapterMetrics } = require('../src/adapter-metrics');
const { evaluateEditorCandidate, sharedProvenCapabilities, GATES } = require('../src/editor-expansion-gates');
const { createReviewComments } = require('../src/review-comments');
const { createDiagnosticsReport } = require('../src/diagnostics-report');

test('session scan metrics report only aggregate outcomes and safe codes', async () => {
  let clock = 0;
  const metrics = createAdapterMetrics({ now: () => clock });
  const scan = metrics.wrapScan(async filePath => {
    clock += 12;
    if (filePath.includes('bad')) throw Object.assign(new Error('/private/bad.fcpxml'), { code: '/private/bad.fcpxml' });
    return { clips: [] };
  });
  await scan('/private/good.fcpxml');
  await assert.rejects(scan('/private/bad.fcpxml'));
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot, { attempts: 2, succeeded: 1, failed: 1, cancelled: 0,
    averageDurationMs: 12, errorCodes: { 'scan-failed': 1 } });
  const report = createDiagnosticsReport({ appVersion: '0.1.0', state: { scanStatus: 'idle' },
    syncState: { operations: [] }, adapterUsage: snapshot });
  assert.equal(report.report.adapterUsage.attempts, 2);
  assert.doesNotMatch(report.bytes.toString(), /private|bad\.fcpxml/);
});

test('second editor remains blocked until first release and separate corpus gates are proven', () => {
  const candidate = { id: 'next-editor', editorVersion: '1.0', os: 'macOS', corpus: ['roundtrip'], evidence: {} };
  const blocked = evaluateEditorCandidate({ candidate });
  assert.equal(blocked.eligibleForImplementation, false);
  assert.ok(blocked.blockers.includes('first-adapter-not-release-ready'));
  assert.ok(blocked.blockers.includes('identity-unproven'));
  assert.deepEqual(sharedProvenCapabilities([{ id: 'fcpxml', releaseReady: false, capabilities: { scan: true } }]),
    { ready: false, capabilities: [] });
  const eligible = evaluateEditorCandidate({ firstAdapterReady: true,
    candidate: { ...candidate, evidence: Object.fromEntries(GATES.map(gate => [gate, 'proven'])) } });
  assert.equal(eligible.eligibleForImplementation, true);
  assert.deepEqual(sharedProvenCapabilities([
    { id: 'first', releaseReady: true, capabilities: { scan: true, apply: false } },
    { id: 'second', releaseReady: true, capabilities: { scan: true, apply: true } }
  ]), { ready: true, capabilities: ['scan'] });
});

test('comments require authorized immutable-revision anchors and survive restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-comments-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { directory,
    authorize: (actor, project, action) => project === 'film' && (actor === 'editor' || action === 'read' && actor === 'viewer'),
    verifyAnchor: async (project, revision, anchor) => project === 'film' && revision === 'revision-1'
      && anchor.timelineId === 'timeline-1' && (anchor.kind === 'range' || anchor.clipId === 'clip-1') };
  const store = createReviewComments(options);
  const clip = await store.add({ actorId: 'editor', projectId: 'film', revisionId: 'revision-1',
    anchor: { kind: 'clip', timelineId: 'timeline-1', clipId: 'clip-1' }, body: 'Check this trim' });
  await store.add({ actorId: 'editor', projectId: 'film', revisionId: 'revision-1',
    anchor: { kind: 'range', timelineId: 'timeline-1', startFrame: 10, endFrame: 24 }, body: 'Music cue' });
  assert.equal((await createReviewComments(options).list({ actorId: 'viewer', projectId: 'film', revisionId: 'revision-1' })).length, 2);
  await assert.rejects(store.add({ actorId: 'viewer', projectId: 'film', revisionId: 'revision-1',
    anchor: clip.anchor, body: 'Write denied' }), { code: 'comment-forbidden' });
  await assert.rejects(store.add({ actorId: 'editor', projectId: 'film', revisionId: 'revision-2',
    anchor: clip.anchor, body: 'Wrong revision' }), { code: 'comment-anchor-unverified' });
  await assert.rejects(store.add({ actorId: 'editor', projectId: 'film', revisionId: 'revision-1',
    anchor: { ...clip.anchor, sourcePath: '/private/clip.mov' }, body: 'Unsafe anchor' }), { code: 'comment-anchor-invalid' });
  assert.equal((await store.resolve({ actorId: 'editor', projectId: 'film', commentId: clip.id })).status, 'resolved');
  assert.doesNotMatch(await fs.readFile(path.join(directory, 'review-comments.json'), 'utf8'), /sourcePath|private/);
  await fs.writeFile(path.join(directory, 'review-comments.json'), JSON.stringify({ version: 1,
    comments: [{ ...clip, anchor: { ...clip.anchor, sourcePath: '/private/clip.mov' } }] }));
  await assert.rejects(store.list({ actorId: 'viewer', projectId: 'film', revisionId: 'revision-1' }),
    { code: 'comment-store-corrupt' });
});
