'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { auditPersonalCompatibility } = require('../scripts/audit-personal-compatibility.cjs');
const ROOT = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function catalog(t) {
  const value = JSON.parse(await fs.readFile(path.join(ROOT, 'phase-0/personal-compatibility-corpus.json')));
  try { for (const entry of value.nativeProjects) await fs.stat(path.join(ROOT, entry.proof.retainedNativeFile)); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Owner-only saved native corpus is not retained in this checkout'); return; } throw error; }
  return value;
}
async function fingerprint(file) {
  const s = await fs.stat(file, { bigint: true });
  return { hash: sha(await fs.readFile(file)), identity: ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(s[key])) };
}
async function retainedCopy(t, source) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'personal-corpus-test-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'retained'); await fs.cp(source, target, { recursive: true });
  return target;
}

test('actual editor-saved Name and 50-picture derived projects are authenticated and reread with the production complete census without source writes', async t => {
  const value = await catalog(t); if (!value) return;
  const files = value.nativeProjects.map(entry => path.join(ROOT, entry.proof.retainedNativeFile));
  const before = await Promise.all(files.map(fingerprint));
  const result = await auditPersonalCompatibility({ catalog: value });
  assert.equal(result.verified, true); assert.equal(result.savedNativeProjects, 2);
  assert.equal(result.productionNativeCensusesRecomputed, 2); assert.equal(result.savedDerivedPictureOccurrences, 50);
  assert.equal(result.editorExports, 4); assert.equal(result.personalEditorTargets, 1);
  assert.equal(result.canonicalEditorFilesOpened, false); assert.equal(result.nativeWritesPerformed, false);
  assert.equal(result.safeToApply, false); assert.equal(result.executionAuthority, false);
  assert.equal(result.releaseSupportRange, null); assert.equal(result.releaseVersionCoverageProven, false);
  assert.deepEqual(await Promise.all(files.map(fingerprint)), before);
});

test('a substituted census commitment or receipt hash cannot inherit the authenticated saved-project claim', async t => {
  const value = await catalog(t); if (!value) return;
  for (const mutate of [copy => copy.nativeProjects[0].census.logicalSha256 = 'a'.repeat(64),
    copy => copy.nativeProjects[1].proof.receiptSha256 = 'b'.repeat(64)]) {
    const copy = structuredClone(value); mutate(copy);
    await assert.rejects(auditPersonalCompatibility({ catalog: copy }));
  }
});

test('a corrupt retained native baseline fails before census acceptance and is never repaired or replaced', async t => {
  const value = await catalog(t); if (!value) return;
  const receipt = JSON.parse(await fs.readFile(path.join(ROOT, 'phase-0/native-result-live-proof.json')));
  const original = path.join(ROOT, receipt.privateRetentionDirectory), copied = await retainedCopy(t, original);
  const relative = path.relative(original, path.join(ROOT, value.nativeProjects[0].proof.retainedNativeFile));
  const file = path.join(copied, relative), bytes = await fs.readFile(file); bytes[0] ^= 1; await fs.writeFile(file, bytes);
  const before = await fingerprint(file);
  await assert.rejects(auditPersonalCompatibility({ catalog: value, nameRetentionDirectory: copied }), /native-identity|not a database/);
  assert.deepEqual(await fingerprint(file), before);
});

test('a changed historical editor admission cannot substitute for the authenticated Name journal', async t => {
  const value = await catalog(t); if (!value) return;
  const receipt = JSON.parse(await fs.readFile(path.join(ROOT, 'phase-0/native-result-live-proof.json')));
  const copied = await retainedCopy(t, path.join(ROOT, receipt.privateRetentionDirectory));
  const file = path.join(copied, 'live/legacy-transactions', receipt.legacy.transactionId, '000012.json');
  const event = JSON.parse(await fs.readFile(file)); event.record.editorProof.openEvidence.resolveVersion = '21.1.3';
  await fs.writeFile(file, JSON.stringify(event));
  await assert.rejects(auditPersonalCompatibility({ catalog: value, nameRetentionDirectory: copied }), /invalid-journal-chain/);
});

test('a changed derived admission ticket cannot inherit a valid saved-project manifest', async t => {
  const value = await catalog(t); if (!value) return;
  const receipt = JSON.parse(await fs.readFile(path.join(ROOT, 'phase-0/media-relink-live-proof.json')));
  const copied = await retainedCopy(t, path.join(ROOT, receipt.privateRetentionDirectory));
  const manifest = JSON.parse(await fs.readFile(path.join(copied, 'manifest.json')));
  const ticket = Object.keys(manifest.files).find(file => file.endsWith('/ticket-2.txt'));
  await fs.appendFile(path.join(copied, ticket), 'changed');
  await assert.rejects(auditPersonalCompatibility({ catalog: value, mediaRetentionDirectory: copied }), /media-artifact/);
});

test('invalid CLI input fails without exposing local paths or project values', async () => {
  await assert.rejects(exec(process.execPath, [path.join(ROOT, 'scripts/audit-personal-compatibility.cjs'), '/Users/private/project']), error => {
    assert.doesNotMatch(error.stderr, /\/Users\/|\/private\/|Error:|\.db/);
    assert.match(error.stderr, /verification-failed|personal-corpus-command/); return true;
  });
});
