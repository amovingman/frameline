const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('../src/project-api-contracts');
const { createResolveAnchorVerifier } = require('../src/resolve-anchor-evidence');
const { mediaAvailabilitySummary } = require('../src/availability-summary');
const { scanFcpXml } = require('../src/fcpxml-adapter');

test('review anchors require an exact snapshot hash and an observed clip or bounded frame range', async () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof',
    'live-mapping-before-schema3.json'), 'utf8'));
  const projectId = snapshot.project_id, timeline = snapshot.timelines[0], clip = timeline.items[0];
  const record = { projectId, revisionId: 'revision-1', snapshotHash: fingerprint(snapshot), snapshot };
  const verify = createResolveAnchorVerifier(async () => record);
  assert.equal(await verify(projectId, 'revision-1', { kind: 'clip', timelineId: timeline.id, clipId: clip.id }), true);
  assert.equal(await verify(projectId, 'revision-1', { kind: 'clip', timelineId: timeline.id, clipId: 'guessed-from-name' }), false);
  assert.equal(await verify(projectId, 'revision-1', { kind: 'range', timelineId: timeline.id,
    startFrame: clip.start_frame, endFrame: clip.end_frame }), true);
  assert.equal(await verify(projectId, 'revision-1', { kind: 'range', timelineId: timeline.id,
    startFrame: clip.start_frame, endFrame: Number.MAX_SAFE_INTEGER }), false);
  record.snapshotHash = '0'.repeat(64);
  assert.equal(await verify(projectId, 'revision-1', { kind: 'clip', timelineId: timeline.id, clipId: clip.id }), false);
});

test('media summary distinguishes missing, unchecked, unspecified, and inaccessible', () => {
  assert.equal(mediaAvailabilitySummary([
    { availability: 'local' }, { availability: 'missing' }, { availability: 'external' },
    { availability: 'unknown' }, { availability: 'unavailable' }
  ]), '5 referenced media assets · 1 available locally · 1 missing · 1 external (unchecked) · 1 source unspecified · 1 could not check');
});

test('read-only compatibility fixture keeps frame boundaries exact and identity unresolved', async () => {
  const fixture = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof', 'sample.fcpxml');
  const scan = await scanFcpXml(fixture);
  assert.deepEqual(await scanFcpXml(fixture), scan);
  assert.deepEqual(scan.clips.map(clip => [clip.offsetFrames, clip.durationFrames, clip.sourceInFrames]),
    [[0, 192, 24], [192, 144, 48]]);
  assert.equal(scan.identityStatus, 'unresolved');
  assert.equal(scan.readOnly, true);
});
