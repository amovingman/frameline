'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeProductTruth } = require('../src/product-truth');
const { revisitEditorChoice } = require('../phase-0/revisit-editor-choice');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

test('sample comparison, history and media are identified beside their content', () => {
  for (const view of ['workspace', 'history', 'media']) {
    const model = describeProductTruth({ view });
    assert.equal(model.sourceKind, 'sample'); assert.match(model.title, /Sample/);
    assert.match(model.detail, /illustrative|demonstration/);
    assert.equal(model.ordinaryApplyAvailable, false); assert.equal(model.releaseSupported, false);
  }
  assert.equal(describeProductTruth({ view: 'resolve' }).sourceKind, 'empty');
});
test('selected but unavailable inventory never substitutes samples or zero for unknown', () => {
  const appState = { selectedProject: { name: 'private.fcpxml' }, scanStatus: 'error', scan: null, revisions: undefined };
  assert.equal(describeProductTruth({ appState }).sourceKind, 'unavailable');
  assert.match(describeProductTruth({ view: 'history', appState }).detail, /Revision count unavailable/);
  assert.doesNotMatch(JSON.stringify(describeProductTruth({ appState })), /private\.fcpxml/);
});
test('real scans distinguish missing, unchecked and unknown while actual zero history stays zero', () => {
  const appState = { selectedProject: {}, scanStatus: 'ready', scan: { media: [] }, revisions: [] };
  const media = describeProductTruth({ view: 'media', appState });
  assert.equal(media.sourceKind, 'scan'); assert.match(media.detail, /unchecked.*unknown.*missing/);
  assert.match(media.detail, /inventory check.*service transfers require their separate explicit review/);
  assert.match(describeProductTruth({ view: 'history', appState }).detail, /^0 saved revisions/);
});
test('captured observations and matching values never claim live state or successful apply', () => {
  for (const sourceMode of ['local', 'service-history']) {
    const model = describeProductTruth({ view: 'resolve', resolveState: { status: 'ready', sourceMode, plan: {} } });
    assert.equal(model.sourceKind, 'observation'); assert.match(model.detail, /Matching observations.*live branch.*successful apply/);
  }
});
test('service states preserve offline provenance and never infer connection from local/sample data', () => {
  for (const [status, state] of [['connected', 'connected'], ['offline', 'offline'], ['sign-in-required', 'disconnected'], ['unexpected', 'unknown']]) {
    const model = describeProductTruth({ serviceState: { status } }); assert.equal(model.service.state, state);
    assert.equal(model.ordinaryApplyAvailable, false);
  }
  assert.match(describeProductTruth({ serviceState: { status: 'offline' } }).service.text, /last successful check/);
  const mixed = describeProductTruth({ view: 'history', serviceState: { status: 'connected' } });
  assert.equal(mixed.sourceKind, 'sample'); assert.match(mixed.detail, /example local history list.*Service panels.*independently/);
  assert.equal(mixed.service.state, 'connected');
  assert.equal(describeProductTruth().service.state, 'unknown');
});
test('editor reassessment is deterministic, evidence-bound and keeps every release/write gate closed', () => {
  const report = revisitEditorChoice(), { decisionSha256, ...body } = report;
  assert.deepEqual(revisitEditorChoice(), report);
  assert.equal(decisionSha256, createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex'));
  assert.equal(report.decisionCompleted, true); assert.equal(report.decision, 'stop-release-retain-read-only-experiment');
  assert.equal(report.safeToApply, false); assert.equal(report.releaseSupported, false);
  assert.equal(report.enforcement.ordinaryWriteSupported, false); assert.equal(report.enforcement.exactScanExperimental, true);
  assert.ok(report.blockers.some(value => value.id === 'stable-clip-and-track-identity'));
  assert.ok(!report.blockers.some(value => ['first-user-cohort', 'release-version-corpus'].includes(value.id)));
  assert.ok(report.reopeningCriteria.every(value => !/cohort|consented first-user/i.test(value)));
  assert.equal(report.alternatives.find(value => value.id === 'native-byte-patching').disposition, 'rejected');
  assert.doesNotMatch(JSON.stringify(report), /\/Users\//);
});
test('checked-in editor decision remains fresh against its recomputed evidence record', () => {
  const recorded = JSON.parse(fs.readFileSync(path.join(__dirname, '../phase-0/editor-integration-decision.json'), 'utf8'));
  assert.deepEqual(recorded, revisitEditorChoice());
});
