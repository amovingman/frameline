'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaAuditView } = require('../src/media-audit-view');
const sourceHash = 'a'.repeat(64), mediaHash = 'b'.repeat(64);
const selection = { projectId: 'film', sourceHash, sourcePath: '/Users/private/edit.fcpxml', copyPath: null };
const report = () => ({ schemaVersion: 1, readOnly: true, sourceFormat: 'fcpxml', sourceVersion: '1.10', sourceHash,
  counts: { total: 1, local: 1, missing: 0, 'offline-volume': 0, 'proxy-only': 0, excluded: 0, external: 0, unknown: 0, fingerprinted: 1 },
  assets: [{ id: 'media-1', displayNames: ['Picture.mov'], status: 'local', reason: 'regular-file-present',
    fingerprintAvailable: true, fingerprint: { size: 12, sha256: mediaHash } }] });
const state = (version, runId, value = report()) => ({ version, busy: false, error: null, selection,
  jobs: [], total: 1, reports: { source: { report: value, completedAt: version * 1000, runId } } });
function fixture() {
  let current = selection; const cache = {};
  return { cache, setSelection: value => { current = value; }, view: createMediaAuditView({ getSelection: () => current,
    getAudit: target => cache[target], setAudit: (target, value) => { cache[target] = value; } }) };
}
test('audit IPC projection omits worker paths, media hashes and future private fields while retaining useful status', () => {
  const { view } = fixture(), input = state(1, 'check-1');
  input.privatePath = '/Users/private/store'; input.reports.source.report.privateURL = 'file:///private/media';
  input.reports.source.report.assets[0].privateLocation = '/Volumes/drive/asset';
  input.jobs = [{ id: 'job:example', sourceHash, target: 'source', status: 'running', progress: 25,
    error: '/Users/private/failure', privateLocation: '/private/jobs',
    detail: { phase: 'hashing', checked: 0, total: 1, bytesRead: 3, totalBytes: 12, filename: '/Users/private/asset' } }];
  const output = view(input), encoded = JSON.stringify(output);
  assert(!encoded.includes('/Users/')); assert(!encoded.includes('/private/')); assert(!encoded.includes('/Volumes/'));
  assert(!encoded.includes(mediaHash)); assert(!encoded.includes('file:'));
  assert.equal(output.reports.source.assets[0].size, 12);
  assert.equal(output.jobs[0].detail.bytesRead, 3); assert.equal(output.jobs[0].error, 'media-audit-failed');
  assert.equal(output.selection.sourceHash, sourceHash);
});
test('repeat state delivery is not a second fingerprint check, and stale snapshots cannot regress the private baseline', () => {
  const { view, cache } = fixture();
  assert.equal(view(state(1, 'first')).reports.source.assets[0].identityVerified, false);
  assert.equal(view(state(2, 'first')).reports.source.assets[0].identityVerified, false);
  assert.equal(view(state(3, 'second')).reports.source.assets[0].identityVerified, true);
  const altered = report(); altered.assets[0].fingerprint = { size: 99, sha256: 'c'.repeat(64) };
  view(state(1, 'stale', altered));
  assert.equal(cache.source._runId, 'second'); assert.equal(cache.source.assets[0].fingerprint.size, 12);
  assert.equal(view(state(4, 'second')).reports.source.assets[0].identityVerified, true);
});
test('reports require the selected project/source and a newly verified copy binding', () => {
  const { view, setSelection, cache } = fixture(), input = state(1, 'first');
  input.reports.copy = input.reports.source;
  assert.deepEqual(Object.keys(view(input).reports), ['source']);
  setSelection({ ...selection, sourceHash: 'c'.repeat(64) });
  assert.deepEqual(view(state(2, 'second')).reports, {}); assert.equal(cache.source._runId, 'first');
  setSelection({ ...selection, copyPath: '/Users/private/review.fcpxml' });
  const copy = state(3, 'second'); copy.reports.copy = copy.reports.source;
  assert.deepEqual(Object.keys(view(copy).reports), ['source', 'copy']);
});
