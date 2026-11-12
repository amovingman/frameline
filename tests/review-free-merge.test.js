const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createResolvePreviewPlan } = require('../src/resolve-preview-plan');
const { riskSnapshotFiles, reviewSnapshotFiles, auditSnapshotFiles, verifyAuditFiles } = require('../phase-0/review-free-merge');

const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const before = path.join(proof, 'live-mapping-before-schema3.json');
const after = path.join(proof, 'live-mapping-after-schema3.json');
const script = path.join(__dirname, '../phase-0/review-free-merge.js');

test('CLI risk assessment remains blocked with explicit unknown coverage', () => {
  const result = riskSnapshotFiles(before, before, after);
  assert.equal(result.gate, 'blocked');
  assert.equal(result.safeToApply, false);
  assert.ok(result.warningCodes.includes('transition-coverage-unknown'));
  const run = spawnSync(process.execPath, [script, 'risk', before, before, after], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout), result);
});

test('CLI reviews, records, and verifies complete source-bound choices without applying', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-review-'));
  try {
    const source = JSON.parse(fs.readFileSync(before, 'utf8'));
    const local = structuredClone(source), incoming = structuredClone(source);
    local.timelines[0].items[0].name = 'Local name';
    incoming.timelines[0].items[0].name = 'Incoming name';
    const paths = [source, local, incoming].map((value, index) => {
      const filename = path.join(dir, `${index}.json`);
      fs.writeFileSync(filename, JSON.stringify(value));
      return filename;
    });
    const planPath = path.join(dir, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(createResolvePreviewPlan(Object.fromEntries(['base', 'local', 'incoming']
      .map((role, index) => [role, fs.readFileSync(paths[index])])))));
    const review = reviewSnapshotFiles(planPath, ...paths);
    assert.equal(review.conflicts.length, 1);
    assert.deepEqual(review.conflicts[0].options, ['keep-local', 'take-incoming']);
    const decisionsPath = path.join(dir, 'decisions.json');
    fs.writeFileSync(decisionsPath, JSON.stringify([{ conflictId: review.conflicts[0].id, choice: 'keep-local' }]));
    const audit = auditSnapshotFiles(planPath, decisionsPath, ...paths);
    assert.equal(audit.choices[0].selectedValue, 'Local name');
    assert.equal(audit.safeToApply, false);
    const auditPath = path.join(dir, 'audit.json');
    fs.writeFileSync(auditPath, JSON.stringify(audit));
    assert.equal(verifyAuditFiles(auditPath, planPath, ...paths).valid, true);
    const run = spawnSync(process.execPath, [script, 'audit', planPath, decisionsPath, ...paths], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout), audit);
    fs.writeFileSync(decisionsPath, '[]');
    const rejected = spawnSync(process.execPath, [script, 'audit', planPath, decisionsPath, ...paths], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stderr, 'invalid-or-stale-review\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
