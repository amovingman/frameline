'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { compareResolveRecovery } = require('../src/resolve-recovery-comparison');

const filename = path.join(__dirname, '../phase-0/resolve-xml-proof/live-mixed-linked-effect-schema3.json');
const source = fs.readFileSync(filename);
const snapshot = () => JSON.parse(source);
const bytes = value => Buffer.from(JSON.stringify(value));

test('compares an explicitly renamed project copy without weakening timeline or item identity', () => {
  const recovered = snapshot();
  recovered.project_id = 'distinct-restored-project';
  recovered.project_name = 'Disposable restored copy';
  recovered.timelines[0].items.reverse();
  recovered.timelines[0].tracks.reverse();
  const recoveredBytes = bytes(recovered);
  const report = compareResolveRecovery(source, recoveredBytes);
  assert.equal(report.status, 'observed-fields-match');
  assert.equal(report.source.sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(report.recovered.sha256, createHash('sha256').update(recoveredBytes).digest('hex'));
  assert.equal(report.recovered.projectId, recovered.project_id);
  assert.equal(report.recoveryValidated, false);
  assert.equal(report.safeToApply, false);
  recovered.timelines[0].id = 'regenerated-timeline-id';
  const changed = compareResolveRecovery(source, bytes(recovered));
  assert.equal(changed.status, 'observed-fields-differ');
  assert.deepEqual(changed.changes.map(change => change.kind).sort(), ['timeline-added', 'timeline-deleted']);
});

test('detects count-preserving timing, media, effect, track, source, name, and link changes', () => {
  const variants = [
    value => { value.timelines[0].items[0].start_frame++; },
    value => { value.timelines[0].items[0].source_start_frame = 1; value.timelines[0].items[0].source_end_frame = 1; },
    value => { value.timelines[0].items[0].media_pool_id = 'changed-media'; },
    value => { value.timelines[0].items[0].effect_counts.ofx = 0; },
    value => { value.timelines[0].tracks[0].name = 'Changed track'; },
    value => { value.timelines[0].items[0].name = 'Changed item'; },
    value => { value.timelines[0].items.forEach(item => { item.linked_item_ids = []; }); }
  ];
  for (const mutate of variants) {
    const recovered = snapshot();
    mutate(recovered);
    const report = compareResolveRecovery(source, bytes(recovered));
    assert.equal(report.status, 'observed-fields-differ');
    assert.ok(report.changes.length > 0);
  }
});

test('rejects malformed captures and CLI reports missing input without exposing paths', () => {
  assert.throws(() => compareResolveRecovery(source, '{}'));
  const recovered = snapshot();
  recovered.timelines[0].items[0].linked_item_ids = ['missing-item'];
  assert.throws(() => compareResolveRecovery(source, bytes(recovered)));
  const script = path.join(__dirname, '../phase-0/compare-resolve-recovery.js');
  const failed = spawnSync(process.execPath, [script, '/private/missing/secret.json', filename], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'resolve-recovery-comparison-failed\n');
  const matched = spawnSync(process.execPath, [script, filename, filename], { encoding: 'utf8' });
  assert.equal(matched.status, 0);
  assert.equal(JSON.parse(matched.stdout).status, 'observed-fields-match');
});
