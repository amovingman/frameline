'use strict';

// A fresh, read-only observation for the owner-controlled offline workflow.
// This does not lock Resolve out, exclude a process starting after observation,
// or authorize publication. The transaction must repeat its checks before write.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');

const INFO = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Info.plist';
const BUILD = Object.freeze({ version: '21.1.2', build: '21.1.20010', bundleId: 'com.blackmagic-design.DaVinciResolve' });
const HASH = /^[a-f0-9]{64}$/;
const MAX_BYTES = 128 * 1024 * 1024;
const fail = code => Object.assign(new Error(`closed-project-${code}`), { code: `closed-project-${code}` });
const need = (value, code) => { if (!value) throw fail(code); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function identity(stat) {
  return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), uid: Number(stat.uid),
    gid: Number(stat.gid), mode: Number(stat.mode) & 0o7777, nlink: Number(stat.nlink) };
}

function parseProcessList(output) {
  need(typeof output === 'string' && output.trim().length > 0, 'process-observation-unavailable');
  const rows = output.trimEnd().split('\n').map(line => {
    const match = /^\s*([1-9][0-9]*)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+[0-9]{1,2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2}\s+[0-9]{4})\s+([^\r\n\x00]+)$/.exec(line);
    need(match && Number.isSafeInteger(Number(match[1])), 'process-observation-unavailable');
    return { pid: Number(match[1]), started: match[2].replace(/\s+/g, ' '), command: match[3].trim() };
  });
  need(new Set(rows.map(row => row.pid)).size === rows.length, 'process-observation-unavailable');
  return rows.filter(row => /(?:^|\/)Resolve$/.test(row.command)
    || /(?:^|\/)DaVinci Resolve(?:\.app(?:\/|$)|$)/.test(row.command)
    || /\/DaVinci Resolve Studio\.app(?:\/|$)/.test(row.command)).sort((a, b) => a.pid - b.pid);
}

function createClosedProjectOfflineGuard({ execFile = promisify(nodeExecFile), platform = process.platform,
  getuid = () => process.getuid(), now = () => new Date() } = {}) {
  async function command(file, args) {
    const result = await execFile(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    need(result && typeof result.stdout === 'string' && typeof result.stderr === 'string' && result.stderr === '', 'observer-output-invalid');
    return result.stdout;
  }
  async function installedBuild() {
    let info;
    try { info = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', INFO])); }
    catch { throw fail('installed-build-unverified'); }
    need(info.CFBundleShortVersionString === BUILD.version && info.CFBundleVersion === BUILD.build
      && info.CFBundleIdentifier === BUILD.bundleId && info.CFBundleExecutable === 'Resolve', 'installed-build-unsupported');
    return { ...BUILD, infoSha256: hash(JSON.stringify(info)), infoPath: INFO };
  }
  async function processes() {
    let values;
    try { values = parseProcessList(await command('/bin/ps', ['-axo', 'pid=,lstart=,comm=', '-ww'])); }
    catch (error) { if (typeof error.code === 'string' && error.code.startsWith('closed-project-')) throw error; throw fail('process-observation-unavailable'); }
    need(values.length === 0, 'resolve-running');
    return values;
  }
  async function noOpenFiles(sourcePath) {
    try {
      await command('/usr/sbin/lsof', ['-nP', '-F', 'pftn', '--', sourcePath]);
    } catch (error) {
      if (error.code === 1 && error.stdout === '' && error.stderr === '') return;
      throw fail('open-file-observation-unavailable');
    }
    // lsof status zero means a matching open file, including an app-owned FD.
    throw fail('source-open');
  }
  async function metadata(sourcePath, sourceIdentity) {
    let flags, listing, names;
    try {
      flags = (await command('/usr/bin/stat', ['-f', '%f', sourcePath])).trim();
      listing = await command('/bin/ls', ['-lde', sourcePath]);
      names = await command('/usr/bin/xattr', [sourcePath]);
    } catch { throw fail('metadata-observation-unavailable'); }
    need(/^[0-9]+$/.test(flags) && Number(flags) === 0, 'source-flags-unsupported');
    // -e prints every ACL entry on its own line, including ACLs hidden by @.
    const lines = listing.trimEnd().split('\n');
    need(lines.length === 1 && /^-[rwxStTs-]{9}[@ ]?\s/.test(lines[0])
      && !lines[0].split(/\s/)[0].includes('+'), 'source-acl-unsupported');
    need(names === '' || names.endsWith('\n'), 'source-attributes-unsupported');
    const list = names === '' ? [] : names.slice(0, -1).split('\n');
    need(list.length <= 128 && new Set(list).size === list.length && list.every(name => name.length > 0
      && !name.startsWith('-') && Buffer.byteLength(name) <= 1024 && !/[\x00-\x1f\x7f]/.test(name)), 'source-attributes-unsupported');
    const attributes = [];
    let totalBytes = 0;
    for (const name of list.sort()) {
      let value;
      try { value = await command('/usr/bin/xattr', ['-px', name, sourcePath]); }
      catch { throw fail('metadata-observation-unavailable'); }
      need(/^[a-fA-F0-9 \t\r\n]*$/.test(value), 'source-attributes-unsupported');
      const valueHex = value.replace(/\s/g, '').toLowerCase();
      totalBytes += valueHex.length / 2;
      need(valueHex.length % 2 === 0 && totalBytes <= 1024 * 1024, 'source-attributes-unsupported');
      attributes.push({ name, valueHex, bytes: valueHex.length / 2 });
    }
    return { mode: sourceIdentity.mode, uid: sourceIdentity.uid, gid: sourceIdentity.gid,
      flags: 0, aclEntries: [], extendedAttributes: attributes, exactPreservationRequired: true };
  }
  async function inspectAccessBoundary(parent) {
    need(path.isAbsolute(parent) && await fs.realpath(parent) === parent, 'source-noncanonical');
    let accessBoundary = null;
      // Resolve creates 0777 descendants inside the owner's 0700 Library.
      // Admit that profile only when another user cannot traverse an owned,
      // ACL-free ancestor. We never repair permissions on the editor library.
      let current = parent;
      for (let depth = 0; depth < 64 && current !== path.parse(current).root; depth++) {
        const ancestor = await fs.lstat(current, { bigint: true });
        need(ancestor.isDirectory() && !ancestor.isSymbolicLink() && Number(ancestor.uid) === getuid(), 'source-directory-unsafe');
        if (!(Number(ancestor.mode) & 0o077) && Number(ancestor.mode) & 0o100) {
          const listing = (await command('/bin/ls', ['-lde', current])).trimEnd().split('\n');
          const aclEntries = listing.slice(1);
          // macOS adds a deny-delete ACL to private Library directories. This
          // restrictive entry grants no traversal; every other ACL is refused.
          need(/^d[rwxStTs-]{9}[@+ ]?\s/.test(listing[0]) && aclEntries.every(line =>
            /^\s*[0-9]+: [A-Za-z0-9:_-]+ deny delete$/.test(line))
            && (!listing[0].split(/\s/)[0].includes('+') || aclEntries.length > 0), 'source-directory-access-unverified');
          accessBoundary = { path: current, device: String(ancestor.dev), inode: String(ancestor.ino),
            uid: Number(ancestor.uid), mode: Number(ancestor.mode) & 0o7777, aclEntries };
          break;
        }
        current = path.dirname(current);
      }
      need(accessBoundary, 'source-directory-unsafe');
    return accessBoundary;
  }
  async function directory(sourcePath, stage) {
    const parent = path.dirname(sourcePath);
    need(await fs.realpath(parent) === parent && await fs.realpath(sourcePath) === sourcePath, 'source-noncanonical');
    const stat = await fs.lstat(parent, { bigint: true });
    need(stat.isDirectory() && Number(stat.uid) === getuid(), 'source-directory-unsafe');
    const accessBoundary = Number(stat.mode) & 0o022 ? await inspectAccessBoundary(parent) : null;
    const entries = ['Project.db'];
    if (stage !== undefined) {
      need(stage && typeof stage.path === 'string' && path.dirname(stage.path) === parent
        && /^\.frameline-apply-[a-f0-9]{32}\.stage$/.test(path.basename(stage.path))
        && HASH.test(stage.sha256 || '') && Number.isSafeInteger(stage.size) && stage.size > 0
        && stage.size <= MAX_BYTES && /^[0-9]+$/.test(String(stage.device))
        && /^[0-9]+$/.test(String(stage.inode)), 'stage-descriptor-invalid');
      const handle = await fs.open(stage.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true }), id = identity(before);
        need(before.isFile() && id.uid === getuid() && id.nlink === 1 && id.device === String(stage.device)
          && id.inode === String(stage.inode) && id.size === stage.size, 'stage-changed');
        need(hash(await handle.readFile()) === stage.sha256 && equal(id, identity(await handle.stat({ bigint: true })))
          && equal(id, identity(await fs.lstat(stage.path, { bigint: true }))), 'stage-changed');
      } finally { await handle.close(); }
      entries.push(path.basename(stage.path));
    }
    need(equal((await fs.readdir(parent)).sort(), entries.sort()), 'source-directory-not-single-file');
    return { ...identity(stat), accessBoundary };
  }
  async function inspect({ sourcePath, expectedSourceHash, stage } = {}) {
    need(platform === 'darwin', 'platform-unsupported');
    need(typeof sourcePath === 'string' && path.isAbsolute(sourcePath) && path.resolve(sourcePath) === sourcePath
      && path.basename(sourcePath) === 'Project.db' && !/[\x00-\x1f\x7f]/.test(sourcePath), 'source-path-invalid');
    need(expectedSourceHash === undefined || HASH.test(expectedSourceHash), 'source-hash-invalid');
    const startedAt = now().toISOString();
    const buildBefore = await installedBuild(), processBefore = await processes();
    const directoryBefore = await directory(sourcePath, stage);
    await noOpenFiles(sourcePath);
    const handle = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let sourceIdentity, bytes;
    try {
      const stat = await handle.stat({ bigint: true });
      sourceIdentity = identity(stat);
      need(stat.isFile() && sourceIdentity.uid === getuid() && sourceIdentity.nlink === 1
        && sourceIdentity.size > 0 && sourceIdentity.size <= MAX_BYTES, 'source-file-unsafe');
      need((sourceIdentity.mode & 0o600) === 0o600 && !(sourceIdentity.mode & 0o7133), 'source-permissions-unsupported');
      bytes = await handle.readFile();
      need(bytes.length === sourceIdentity.size && equal(sourceIdentity, identity(await handle.stat({ bigint: true })))
        && equal(sourceIdentity, identity(await fs.lstat(sourcePath, { bigint: true }))), 'source-changed');
    } finally { await handle.close(); }
    const sourceMetadata = await metadata(sourcePath, sourceIdentity);
    const sourceHash = hash(bytes);
    need(expectedSourceHash === undefined || sourceHash === expectedSourceHash, 'source-hash-stale');
    await noOpenFiles(sourcePath);
    const processAfter = await processes(), buildAfter = await installedBuild();
    need(equal(processBefore, processAfter) && equal(buildBefore, buildAfter), 'editor-state-changed');
    const metadataAfter = await metadata(sourcePath, sourceIdentity);
    need(equal(sourceMetadata, metadataAfter) && equal(sourceIdentity, identity(await fs.lstat(sourcePath, { bigint: true })))
      && equal(directoryBefore, await directory(sourcePath, stage)), 'source-changed');
    return { schemaVersion: 1, sourcePath, sha256: sourceHash, size: bytes.length, identity: sourceIdentity,
      directoryIdentity: directoryBefore, metadata: sourceMetadata, installedBuild: buildAfter,
      processChecks: { before: processBefore, after: processAfter, pidAndStartCompared: true },
      openFileAbsenceObservedTwice: true, startedAt, checkedAt: now().toISOString(),
      freshObservationOnly: true, concurrencyExclusionProven: false, safeToApply: false };
  }
  return { inspect, inspectAccessBoundary, inspectFileMetadata: async file => metadata(file, identity(await fs.lstat(file, { bigint: true }))) };
}

function assertSameClosedProjectObservation(before, after) {
  need(before?.schemaVersion === 1 && after?.schemaVersion === 1 && before.freshObservationOnly === true
    && after.freshObservationOnly === true && before.safeToApply === false && after.safeToApply === false
    && HASH.test(before.sha256 || '') && HASH.test(after.sha256 || ''), 'observation-invalid');
  for (const key of ['sourcePath', 'sha256', 'size', 'identity', 'directoryIdentity', 'metadata', 'installedBuild']) {
    need(equal(before[key], after[key]), 'source-changed');
  }
  return true;
}

const defaultGuard = createClosedProjectOfflineGuard();
module.exports = { createClosedProjectOfflineGuard, inspectClosedProjectSource: options => defaultGuard.inspect(options),
  inspectClosedProjectFileMetadata: file => defaultGuard.inspectFileMetadata(file),
  assertSameClosedProjectObservation, parseProcessList };
