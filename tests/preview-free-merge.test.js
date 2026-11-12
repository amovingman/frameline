const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { previewSnapshotFiles, verifyPreviewFile } = require('../phase-0/preview-free-merge');

const proof = path.join(__dirname, '../phase-0/resolve-xml-proof');
const base = path.join(proof, 'live-mapping-before-schema3.json');
const incoming = path.join(proof, 'live-mapping-after-schema3.json');
const script = path.join(__dirname, '../phase-0/preview-free-merge.js');

test('CLI previews three Free snapshots without paths or write authorization', () => {
  const direct = previewSnapshotFiles(base, base, incoming);
  assert.deepEqual(direct.classification.decisions.map(decision => decision.status), ['incoming-only', 'incoming-only']);
  const run = spawnSync(process.execPath, [script, base, base, incoming], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  const printed = JSON.parse(run.stdout);
  assert.deepEqual(printed, direct);
  assert.equal(printed.safeToApply, false);
  assert.doesNotMatch(run.stdout, /file:\/\/|Users\/user|Downloads/);
});

test('verify mode reports a stale local snapshot from exact saved source hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-preview-'));
  try {
    const local = path.join(dir, 'local.json');
    const planPath = path.join(dir, 'plan.json');
    fs.copyFileSync(base, local);
    fs.writeFileSync(planPath, JSON.stringify(previewSnapshotFiles(base, local, incoming)));
    assert.equal(verifyPreviewFile(planPath, base, local, incoming).valid, true);
    fs.appendFileSync(local, '\n');
    const run = spawnSync(process.execPath, [script, 'verify', planPath, base, local, incoming], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(run.stdout).staleRoles, ['local']);
    assert.equal(JSON.parse(run.stdout).safeToApply, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI uses path-free errors for missing inputs', () => {
  const run = spawnSync(process.execPath, [script, base, '/private/tmp/secret-missing.json', incoming], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'invalid-or-incompatible-preview\n');
});
