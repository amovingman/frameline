'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCandidateLedger, verifyCandidateLedger } = require('../src/resolve-candidate-ledger');

const root = path.join(__dirname, '../phase-0/resolve-xml-proof');
const source = phase => ({ snapshot: fs.readFileSync(path.join(root, `live-mapping-${phase}-schema3.json`)),
  xml: fs.readFileSync(path.join(root, `live-mapping-${phase}.fcpxmld/Info.fcpxml`)) });
const before = source('before'), after = source('after');
const timelineId = 'a00c8594-ea28-480e-bfd9-4d3ed64d62ee';
const sources = { beforeSnapshotBytes: before.snapshot, beforeExportBytes: before.xml,
  afterSnapshotBytes: after.snapshot, afterExportBytes: after.xml, timelineId };

test('paired live observations retain API IDs while XML positions move, without proving a mapping', () => {
  const ledger = createCandidateLedger(sources);
  assert.equal(ledger.status, 'paired-candidates-only');
  assert.equal(ledger.retained.length, 5);
  assert.deepEqual(ledger.retained.find(row => row.apiItemId === '8543c72f-9c48-4744-81b5-ccc620e7c9bb'),
    { apiItemId: '8543c72f-9c48-4744-81b5-ccc620e7c9bb', beforeXmlSpineIndex: 5, afterXmlSpineIndex: 6 });
  assert.equal(ledger.persistentMappingProven, false);
  assert.equal(ledger.safeToApply, false);
  assert.equal(verifyCandidateLedger(ledger, sources).valid, true);
  assert.equal(verifyCandidateLedger(ledger, { ...sources, afterExportBytes: Buffer.concat([after.xml, Buffer.from(' ')]) }).valid, false);
  assert.equal(verifyCandidateLedger({ ...ledger, safeToApply: true }, sources).valid, false);
});

test('ambiguous signatures do not produce retained or generated ID claims', () => {
  const duplicate = JSON.parse(before.snapshot);
  duplicate.timelines[0].items.push({ ...duplicate.timelines[0].items[0], id: 'duplicate' });
  const ledger = createCandidateLedger({ ...sources, beforeSnapshotBytes: Buffer.from(JSON.stringify(duplicate)) });
  assert.equal(ledger.status, 'unresolved');
  assert.deepEqual(ledger.retained, []);
  assert(ledger.unresolvedBefore > 0);
  assert.equal(ledger.safeToApply, false);
});
