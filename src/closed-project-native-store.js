'use strict';
// Runtime typed-cell reader/writer. SQL writes are confined to new private
// candidates. This module neither closes Resolve nor publishes into a library.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const exec = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ROOT = path.join(__dirname, 'native', 'resolve');
const MAX_BYTES = 128 * 1024 * 1024;
const HASHES = {
  'native-sqlite-name-copy.py': '95c3f449ccccef2d57ac04c93586a9b5d2af1996361b8fd877f4b344fe526b40',
  'resolve-native-sqlite-snapshot.py': '35bc1c7c324f63e7066cf77c22627a3a56a93e66c3427e14cd0bc0aa8a5c82d6'
};
function need(condition, code) { if (!condition) throw new Error(`native-store-${code}`); }
function physicalProfile(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length >= 100 && bytes.length <= MAX_BYTES, 'physical-size');
  const encoded = bytes.readUInt16BE(16), pageSize = encoded === 1 ? 65536 : encoded;
  need(bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')), 'physical-signature');
  need(pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0, 'physical-page-size');
  need(bytes[18] === 1 && bytes[19] === 1 && bytes[20] === 0, 'physical-journal-or-reserved-page-extension');
  need(bytes[21] === 64 && bytes[22] === 32 && bytes[23] === 32, 'physical-payload-fractions');
  need(bytes.readUInt32BE(44) === 4 && bytes.readUInt32BE(56) === 1, 'physical-schema-or-encoding');
  need(bytes.subarray(72, 92).every(value => value === 0), 'physical-reserved-header-extension');
  need(bytes.readUInt32BE(24) === bytes.readUInt32BE(92), 'physical-page-count-counter');
  need(bytes.readUInt32BE(28) > 0 && pageSize * bytes.readUInt32BE(28) === bytes.length, 'physical-unaccounted-bytes');
}
async function stableBytes(filename, limit = MAX_BYTES) {
  need(typeof filename === 'string' && path.isAbsolute(filename)
    && await fs.realpath(filename) === filename, 'absolute-canonical-file-required');
  const fd = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat({ bigint: true });
    need(before.isFile() && before.nlink === 1n && Number(before.uid) === process.getuid()
      && before.size > 0n && before.size <= BigInt(limit), 'unsafe-file');
    const bytes = await fd.readFile(), after = await fd.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
    const same = value => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => before[key] === value[key]);
    need(bytes.length === Number(before.size) && same(after) && same(named), 'file-changed');
    return bytes;
  } finally { await fd.close(); }
}
async function run(script, args) {
  for (const [file, expected] of Object.entries(HASHES)) {
    need(sha(await fs.readFile(path.join(ROOT, file))) === expected, 'helper-changed');
  }
  const result = await exec('python3', ['-B', path.join(ROOT, script), ...args],
    { timeout: 30000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(result.stdout);
}
async function inspectClosedDatabase({ sourcePath, directory, projectId, projectName }) {
  need(path.isAbsolute(sourcePath) && path.isAbsolute(directory), 'absolute-path-required');
  const snapshotPath = path.join(directory, 'source.db');
  const facts = await run('resolve-native-sqlite-snapshot.py', ['snapshot', sourcePath, snapshotPath, projectId, projectName, 'single-project-file']);
  const databaseBytes = await stableBytes(snapshotPath), censusBytes = await stableBytes(`${snapshotPath}.census.json`, 24 * 1024 * 1024);
  need(sha(databaseBytes) === facts.snapshot.sha256 && sha(censusBytes) === facts.census.sha256, 'output-changed');
  physicalProfile(databaseBytes);
  return { facts, snapshotPath, censusPath: `${snapshotPath}.census.json`, databaseBytes, censusBytes };
}
async function createNameCandidate({ snapshotPath, directory, plan }) {
  need(path.isAbsolute(snapshotPath) && path.isAbsolute(directory) && plan.operation === 'closed-project-name-apply-plan'
    && plan.edit.kind === 'video' && plan.edit.field === 'Name', 'plan-required');
  const before = await stableBytes(snapshotPath); physicalProfile(before);
  need(sha(before) === plan.source.sha256, 'source-stale');
  const candidatePath = path.join(directory, 'edited.db');
  const facts = await run('native-sqlite-name-copy.py', [snapshotPath, candidatePath, plan.projectId,
    plan.projectName, plan.edit.itemId, plan.edit.oldName, plan.edit.newName, plan.source.sha256]);
  const after = await stableBytes(candidatePath); physicalProfile(after);
  need(facts.allOtherApplicationValuesPreserved === true && facts.libraryPublicationPerformed === false
    && facts.outputSnapshot.sha256 === sha(after) && sha(await stableBytes(snapshotPath)) === sha(before), 'candidate-unverified');
  return { candidatePath, facts };
}
async function writeEvidence(filename, value) {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function compareNameCandidate({ backup, candidate, directory, plan }) {
  const oldBytes = await stableBytes(backup.path), newBytes = await stableBytes(candidate.path);
  physicalProfile(oldBytes); physicalProfile(newBytes);
  need(sha(oldBytes) === backup.sha256 && sha(newBytes) === candidate.sha256 && backup.sha256 === plan.source.sha256, 'source-stale');
  const before = await run('resolve-native-sqlite-snapshot.py', ['census', backup.path, plan.projectId, plan.projectName]);
  const after = await run('resolve-native-sqlite-snapshot.py', ['census', candidate.path, plan.projectId, plan.projectName]);
  const a = path.join(directory, 'before.json'), b = path.join(directory, 'after.json');
  await writeEvidence(a, before); await writeEvidence(b, after);
  const comparison = await run('resolve-native-sqlite-snapshot.py', ['compare', a, b,
    JSON.stringify({ projectId: plan.projectId, itemId: plan.edit.itemId, oldName: plan.edit.oldName, newName: plan.edit.newName })]);
  need(comparison.allOtherApplicationValuesPreserved === true && comparison.authorizedNameCell?.itemId === plan.edit.itemId
    && before.snapshot.sha256 === backup.sha256 && after.snapshot.sha256 === candidate.sha256
    && sha(await stableBytes(backup.path)) === backup.sha256 && sha(await stableBytes(candidate.path)) === candidate.sha256, 'preservation-unverified');
  return { verified: true, planId: plan.planId, sourceSha256: backup.sha256, candidateSha256: candidate.sha256,
    changedFields: 1, proofSha256: sha(JSON.stringify(comparison)), comparison };
}
module.exports = { inspectClosedDatabase, createNameCandidate, compareNameCandidate };
