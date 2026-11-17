'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateResolveSnapshot } = require('../src/resolve-snapshot-validator');
const { normalizeResolveSnapshot } = require('../src/resolve-snapshot-normalizer');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');

test('live Free Console fixture retains video, transition, and audio observations', () => {
  const filename = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof',
    'live-mixed-audio-video-transition-schema3.json');
  const bytes = fs.readFileSync(filename);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),
    '4f2b6420e03d0123cfeeff93ce8ed299ff27d0b9518be5ea22498c529f372b12');
  const snapshot = JSON.parse(bytes);
  validateResolveSnapshot(snapshot);
  const manifest = normalizeResolveSnapshot(snapshot);
  assert.equal(manifest.timelines.length, 1);
  const items = manifest.timelines[0].items;
  assert.equal(items.length, 51);
  assert.deepEqual(items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1;
    return counts;
  }, {}), { audio: 48, video: 2, transition: 1 });
  const picture = items.filter(item => item.type === 'video');
  assert.equal(picture[0].mediaPoolId, picture[1].mediaPoolId);
  assert.notEqual(picture[0].id, picture[1].id);
  const transition = items.find(item => item.type === 'transition');
  assert.equal(transition.name, 'Cross Dissolve');
  assert.equal(transition.mediaPoolId, null);
  assert.equal(transition.sourceStartFrame, null);
  assert.equal(transition.sourceEndFrame, null);
  assert.ok(transition.startFrame < picture[0].endFrame);
  assert.ok(transition.endFrame > picture[1].startFrame);
});

test('paired live captures preserve linked AV IDs and expose an OFX count change', () => {
  const directory = path.join(__dirname, '..', 'phase-0', 'resolve-xml-proof');
  const before = fs.readFileSync(path.join(directory, 'live-mixed-audio-video-transition-schema3.json'));
  const after = fs.readFileSync(path.join(directory, 'live-mixed-linked-effect-schema3.json'));
  assert.equal(createHash('sha256').update(after).digest('hex'),
    '21b11d8ffe6ec71635936e6b8fbffbbee2cc31486ceb42d026900a25da81a2b2');
  const snapshot = JSON.parse(after);
  validateResolveSnapshot(snapshot);
  const items = snapshot.timelines[0].items;
  assert.equal(items.length, 53);
  const linked = items.filter(item => item.linked_item_ids.length);
  assert.equal(linked.length, 2);
  assert.deepEqual(linked.map(item => item.type).sort(), ['audio', 'video']);
  assert.deepEqual(linked[0].linked_item_ids, [linked[1].id]);
  assert.deepEqual(linked[1].linked_item_ids, [linked[0].id]);
  assert.equal(linked[0].media_pool_id, linked[1].media_pool_id);
  const effected = items.filter(item => item.effect_counts.ofx > 0);
  assert.equal(effected.length, 1);
  assert.equal(effected[0].effect_counts.ofx, 1);
  const plan = createResolvePreviewPlan({ base: before, local: before, incoming: after });
  assert.deepEqual(plan.classification.decisions.map(({ field, status }) => [field, status]), [
    ['existence', 'incoming-only'], ['existence', 'incoming-only'],
    ['effectCounts.ofx', 'incoming-only']
  ]);
  assert.equal(plan.safeToApply, false);
});
