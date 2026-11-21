'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { revisitEditorChoice } = require('../phase-0/revisit-editor-choice');
const ROOT = path.resolve(__dirname, '..');
const archive = path.join(ROOT, 'phase-0/evidence-sources/support-matrix-observed-20261119.md.txt');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('the original editor decision and hash reproduce from its exact archived support matrix while current personal profiles stay separate', () => {
  const filename = path.join(ROOT, 'phase-0/editor-integration-decision.json'), before = fs.readFileSync(filename);
  const recorded = JSON.parse(before), reads = [];
  const actual = revisitEditorChoice(file => { reads.push(file); return fs.readFileSync(file); });
  assert.deepEqual(actual, recorded);
  assert.equal(actual.decisionSha256, recorded.decisionSha256);
  assert.equal(actual.evidence['phase-0/SUPPORT_MATRIX.md'], sha(fs.readFileSync(archive)));
  assert.notEqual(sha(fs.readFileSync(path.join(ROOT, 'phase-0/SUPPORT_MATRIX.md'))), actual.evidence['phase-0/SUPPORT_MATRIX.md']);
  assert(reads.includes(archive)); assert(!reads.includes(path.join(ROOT, 'phase-0/SUPPORT_MATRIX.md')));
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('changed archived matrix bytes cannot silently refresh or inherit the historical decision', () => {
  assert.throws(() => revisitEditorChoice(file => file === archive
    ? Buffer.concat([fs.readFileSync(file), Buffer.from('\nChanged historical evidence\n')]) : fs.readFileSync(file)),
  /historical-support-matrix-changed/);
});
