'use strict';

// Main-process transaction adapter only. Its caller holds the per-source app
// lock and has durably retained the backup and publication intent. These checks
// observe an offline editor; they do not exclude unrelated external writers.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createClosedProjectOfflineGuard } = require('./closed-project-apply-offline-guard');

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = code => Object.assign(new Error(`closed-project-publication-${code}`), { code: `closed-project-publication-${code}` });
const need = (value, code) => { if (!value) throw fail(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const statIdentity = stat => ({ device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
  mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), uid: Number(stat.uid), gid: Number(stat.gid),
  mode: Number(stat.mode) & 0o7777, nlink: Number(stat.nlink) });

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readArtifact(artifact) {
  need(artifact && path.isAbsolute(artifact.path || '') && HASH.test(artifact.sha256 || '')
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0 && artifact.bytes <= 128 * 1024 * 1024,
  'artifact-invalid');
  need(await fs.realpath(artifact.path) === artifact.path, 'artifact-noncanonical');
  const handle = await fs.open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true }), id = statIdentity(before);
    need(before.isFile() && id.nlink === 1 && id.uid === process.getuid() && !(id.mode & 0o077)
      && id.size === artifact.bytes, 'artifact-unsafe');
    const bytes = await handle.readFile();
    need(bytes.length === id.size && hash(bytes) === artifact.sha256 && equal(id, statIdentity(await handle.stat({ bigint: true })))
      && equal(id, statIdentity(await fs.lstat(artifact.path, { bigint: true }))), 'artifact-changed');
    return { bytes, identity: id };
  } finally { await handle.close(); }
}

function createClosedProjectPublisher({ execFile = promisify(nodeExecFile), offlineGuard: defaultGuard } = {}) {
  defaultGuard ||= createClosedProjectOfflineGuard({ execFile });
  async function attributeCommand(args) {
    const result = await execFile('/usr/bin/xattr', args, { encoding: 'utf8', timeout: 10000,
      maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    need(result?.stdout === '' && result?.stderr === '', 'attribute-write-unverified');
  }
  async function preserveMetadata(stagePath, expected, guard) {
    const handle = await fs.open(stagePath, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      if (current.uid !== expected.uid || current.gid !== expected.gid) await handle.chown(expected.uid, expected.gid);
      await handle.chmod(expected.mode);
      await handle.sync();
    } finally { await handle.close(); }
    // Only the new, unpublished stage is changed. The original's attributes,
    // ACL, flags and permissions are never cleared or rewritten.
    const staged = await guard.inspectFileMetadata(stagePath);
    for (const attribute of staged.extendedAttributes) {
      if (!expected.extendedAttributes.some(value => value.name === attribute.name)) {
        await attributeCommand(['-d', attribute.name, stagePath]);
      }
    }
    for (const attribute of expected.extendedAttributes) {
      if (!staged.extendedAttributes.some(value => value.name === attribute.name && value.valueHex === attribute.valueHex)) {
        await attributeCommand(['-wx', attribute.name, attribute.valueHex, stagePath]);
      }
    }
    need(equal(await guard.inspectFileMetadata(stagePath), expected), 'metadata-not-preserved');
    const synced = await fs.open(stagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await synced.sync(); } finally { await synced.close(); }
  }
  async function publish({ plan, expectedSource, artifact, direction, transactionId, sourcePath, originalMetadata,
    offlineGuard = defaultGuard } = {}) {
    need(HASH.test(plan?.planId || '') && ID.test(transactionId || '') && ['apply', 'rollback'].includes(direction), 'context-invalid');
    need(expectedSource && typeof expectedSource.path === 'string' && HASH.test(expectedSource.sha256 || '')
      && Number.isSafeInteger(expectedSource.bytes) && expectedSource.bytes > 0, 'source-invalid');
    sourcePath ||= expectedSource.path;
    need(sourcePath === expectedSource.path && typeof offlineGuard?.inspect === 'function'
      && typeof offlineGuard?.inspectFileMetadata === 'function', 'trusted-source-and-guard-required');
    const before = await offlineGuard.inspect({ sourcePath, expectedSourceHash: expectedSource.sha256 });
    if (originalMetadata !== undefined) need(equal(before.metadata, originalMetadata), 'original-metadata-changed');
    need(before.sha256 === expectedSource.sha256 && before.size === expectedSource.bytes
      && before.identity.device === String(expectedSource.dev) && before.identity.inode === String(expectedSource.ino), 'source-stale');
    const candidate = await readArtifact(artifact);
    need(artifact.path !== sourcePath && !(candidate.identity.device === before.identity.device
      && candidate.identity.inode === before.identity.inode), 'distinct-artifact-required');
    const parent = path.dirname(sourcePath), stagePath = path.join(parent, `.frameline-apply-${randomBytes(16).toString('hex')}.stage`);
    let stageIdentity = null, renamed = false;
    try {
      const stage = await fs.open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        stageIdentity = statIdentity(await stage.stat({ bigint: true }));
        await stage.writeFile(candidate.bytes); await stage.sync();
      } finally { await stage.close(); }
      await preserveMetadata(stagePath, before.metadata, offlineGuard);
      const stageStat = await fs.lstat(stagePath, { bigint: true });
      need(stageStat.isFile() && String(stageStat.dev) === stageIdentity.device
        && String(stageStat.ino) === stageIdentity.inode && stageStat.nlink === 1n, 'stage-changed');
      const descriptor = { path: stagePath, device: stageIdentity.device, inode: stageIdentity.inode,
        sha256: artifact.sha256, size: artifact.bytes };
      const last = await offlineGuard.inspect({ sourcePath, expectedSourceHash: expectedSource.sha256, stage: descriptor });
      need(equal(before.identity, last.identity) && equal(before.metadata, last.metadata)
        && equal(before.installedBuild, last.installedBuild)
        && ['device', 'inode', 'uid', 'gid', 'mode'].every(key => before.directoryIdentity[key] === last.directoryIdentity[key]), 'source-changed');
      need(equal(await offlineGuard.inspectFileMetadata(stagePath), before.metadata), 'stage-metadata-changed');
      const finalStage = await fs.lstat(stagePath, { bigint: true });
      need(finalStage.isFile() && finalStage.nlink === 1n && String(finalStage.dev) === stageIdentity.device
        && String(finalStage.ino) === stageIdentity.inode && Number(finalStage.size) === artifact.bytes
        && hash(await fs.readFile(stagePath)) === artifact.sha256, 'stage-changed');
      need(equal(last.identity, statIdentity(await fs.lstat(sourcePath, { bigint: true }))), 'last-source-changed');
      await fs.rename(stagePath, sourcePath); renamed = true;
      await syncDirectory(parent);
      const after = await offlineGuard.inspect({ sourcePath, expectedSourceHash: artifact.sha256 });
      need(after.sha256 === artifact.sha256 && after.size === artifact.bytes
        && after.identity.device === stageIdentity.device && after.identity.inode === stageIdentity.inode
        && equal(after.metadata, before.metadata), 'published-verification-failed');
      return { transactionId, planId: plan.planId, direction, sourceSha256: artifact.sha256, atomic: true,
        metadataPreserved: true, sourceMetadata: before.metadata, sourceIdentityBefore: before.identity,
        sourceIdentityAfter: after.identity, applicationSourceLockHeld: true,
        applicationSourceLockProvidedByTrustedCaller: true, editorOfflineRechecked: true,
        concurrentWriterResistanceProven: false };
    } catch (error) {
      if (!renamed && stageIdentity) {
        try {
          const stat = await fs.lstat(stagePath, { bigint: true });
          if (stat.isFile() && stat.nlink === 1n && String(stat.dev) === stageIdentity.device
            && String(stat.ino) === stageIdentity.inode) {
            await fs.unlink(stagePath); await syncDirectory(parent);
          }
        } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') error.stageCleanupFailed = true; }
      }
      error.publicationMayHaveOccurred = renamed;
      throw error;
    }
  }
  return { publish };
}

const publisher = createClosedProjectPublisher();
module.exports = { createClosedProjectPublisher, publishClosedProjectFile: options => publisher.publish(options) };
