'use strict';

// Bind the selected root-level disk project to Resolve's configured library and
// actual open file descriptors during the native readback admission barrier.
// An API UUID or an echoed expected hash alone is not this source evidence.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseProcessList, createClosedProjectOfflineGuard } = require('./closed-project-apply-offline-guard');
const CONFIG = path.join(os.homedir(), 'Library/Preferences/Blackmagic Design/DaVinci Resolve/dblist.conf');
const RESOLVE = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve';
const RESOLVE_IO_HELPER = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/XPCServices/IOXPC.xpc/Contents/MacOS/IOXPC';
const SHA = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const need = (value, code) => { if (!value) throw Object.assign(new Error(`closed-source-binding-${code}`), { code: `closed-source-binding-${code}` }); };
const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size),
  mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });

function parseDiskLibraryConfig(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 65536, 'configuration-invalid');
  const text = bytes.toString('utf8');
  need(Buffer.from(text).equals(bytes) && text.endsWith('\n') && !/[\x00-\x09\x0b-\x1f\x7f]/.test(text), 'configuration-invalid');
  const records = text.slice(0, -1).split('\n').map(line => {
    const parts = line.split(':');
    need(parts.length === 6 && parts[0].trim().length > 0 && parts[0] === parts[0].trim()
      && path.isAbsolute(parts[1]) && path.resolve(parts[1]) === parts[1]
      && ['', '*'].includes(parts[2]) && parts[3] === '' && parts[4] === '' && parts[5] === 'DISK', 'configuration-profile-unsupported');
    return { name: parts[0], libraryRoot: parts[1] };
  });
  need(records.length <= 64 && new Set(records.map(record => record.name)).size === records.length
    && new Set(records.map(record => record.libraryRoot)).size === records.length, 'configuration-ambiguous');
  return records;
}

function parseResolveOpenFiles(output, expectedPid) {
  need(typeof output === 'string' && output.endsWith('\n') && !output.includes('\0'), 'open-files-invalid');
  const files = [];
  let pid = null, record = null;
  for (const line of output.slice(0, -1).split('\n')) {
    const tag = line[0], value = line.slice(1);
    if (tag === 'p') {
      need(pid === null && /^[1-9][0-9]*$/.test(value) && Number(value) === expectedPid, 'open-files-process');
      pid = Number(value);
    } else if (tag === 'f') {
      need(pid !== null && value.length > 0, 'open-files-order');
      if (record) files.push(record);
      record = { fd: value };
    } else {
      need(record && ['t', 'D', 'i', 'n'].includes(tag) && !Object.hasOwn(record, tag), 'open-files-invalid');
      record[tag] = value;
    }
  }
  if (record) files.push(record);
  need(pid === expectedPid, 'open-files-process');
  return files.filter(file => /(?:^|\/)Project\.db(?:$|\s)/.test(file.n || '')).map(file => {
    need(/^[0-9]+$/.test(file.fd) && file.t === 'REG' && /^0x[0-9a-f]+$/i.test(file.D || '')
      && /^[0-9]+$/.test(file.i || '') && path.isAbsolute(file.n) && path.resolve(file.n) === file.n
      && path.basename(file.n) === 'Project.db' && !/[\x00-\x1f\x7f]/.test(file.n), 'open-project-file-invalid');
    return { path: file.n, device: String(BigInt(file.D)), inode: file.i };
  });
}

function createClosedProjectSourceBinding({ execFile = promisify(nodeExecFile), configPath = CONFIG,
  platform = process.platform, getuid = () => process.getuid(), now = () => new Date() } = {}) {
  const accessGuard = createClosedProjectOfflineGuard({ execFile, platform, getuid, now });
  async function stableFile(filename, limit, config = false) {
    need(path.isAbsolute(filename || '') && await fs.realpath(filename) === filename, 'canonical-file-required');
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      need(before.isFile() && before.nlink === 1n && Number(before.uid) === getuid()
        && before.size > 0n && before.size <= BigInt(limit), 'file-unsafe');
      if (config && Number(before.mode) & 0o022) await accessGuard.inspectAccessBoundary(path.dirname(filename));
      const bytes = await handle.readFile(), id = identity(before);
      need(bytes.length === id.size && same(id, identity(await handle.stat({ bigint: true })))
        && same(id, identity(await fs.lstat(filename, { bigint: true }))), 'file-changed');
      return { bytes, identity: id };
    } finally { await handle.close(); }
  }
  async function prepare({ sourcePath, projectName } = {}) {
    need(platform === 'darwin', 'platform-unsupported');
    need(typeof projectName === 'string' && projectName.trim().length > 0 && projectName !== '.' && projectName !== '..'
      && !/[\x00-\x1f\x7f/\\:]/.test(projectName), 'project-name-invalid');
    const config = await stableFile(configPath, 65536, true), libraries = parseDiskLibraryConfig(config.bytes);
    need(typeof sourcePath === 'string' && path.isAbsolute(sourcePath) && await fs.realpath(sourcePath) === sourcePath, 'source-path-invalid');
    const matches = libraries.filter(library => sourcePath === path.join(library.libraryRoot,
      'Resolve Projects', 'Users', 'guest', 'Projects', projectName, 'Project.db'));
    need(matches.length === 1, 'root-project-library-unbound');
    const library = matches[0];
    need(await fs.realpath(library.libraryRoot) === library.libraryRoot, 'library-noncanonical');
    const stat = await fs.lstat(library.libraryRoot);
    need(stat.isDirectory() && stat.uid === getuid(), 'library-owner-invalid');
    return { schemaVersion: 1, sourcePath, projectName, libraryRoot: library.libraryRoot, configPath,
      configSha256: hash(config.bytes), expectedCurrentDatabase: { DbType: 'Disk', DbName: library.name },
      expectedCurrentFolder: 'Root' };
  }
  async function command(file, args) {
    let result;
    try { result = await execFile(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }); }
    catch { need(false, 'observer-unavailable'); }
    need(typeof result.stdout === 'string' && result.stderr === '', 'observer-unavailable');
    return result.stdout;
  }
  async function currentProcess() {
    const processes = parseProcessList(await command('/bin/ps', ['-axo', 'pid=,lstart=,comm=', '-ww']));
    const main = processes.filter(process => process.command === RESOLVE);
    // The pinned installed app starts this IO XPC service during native reads.
    // It is not a second editor instance; unknown helpers and alternate Resolve
    // installations remain unsupported, and only the main PID binds DB FDs.
    need(main.length === 1 && processes.every(process => process.command === RESOLVE
      || process.command === RESOLVE_IO_HELPER), 'resolve-process-ambiguous');
    return main[0];
  }
  async function openFiles(process, source) {
    const files = parseResolveOpenFiles(await command('/usr/sbin/lsof', ['-nP', '-a', '-p', String(process.pid), '-F', 'pftDin']), process.pid);
    need(files.length > 0 && files.every(file => file.path === source.path && file.device === source.device
      && file.inode === source.inode), 'open-project-source-differs');
    return files.length;
  }
  async function observe({ binding, expectedSha256 } = {}) {
    need(binding?.schemaVersion === 1 && SHA.test(expectedSha256 || ''), 'input-invalid');
    const beforeBinding = await prepare({ sourcePath: binding.sourcePath, projectName: binding.projectName });
    need(same(beforeBinding, binding), 'configuration-changed');
    const startedAt = now().toISOString(), processBefore = await currentProcess();
    const readBefore = await stableFile(binding.sourcePath, 128 * 1024 * 1024);
    need(hash(readBefore.bytes) === expectedSha256, 'source-hash-differs');
    need(same((await fs.readdir(path.dirname(binding.sourcePath))).sort(), ['Project.db']), 'source-sidecars-or-extra-files');
    const source = { path: binding.sourcePath, sha256: expectedSha256, ...readBefore.identity };
    const descriptorsBefore = await openFiles(processBefore, source);
    const readAfter = await stableFile(binding.sourcePath, 128 * 1024 * 1024);
    need(readAfter.bytes.equals(readBefore.bytes) && same(readAfter.identity, readBefore.identity), 'source-changed');
    const descriptorsAfter = await openFiles(processBefore, source), processAfter = await currentProcess();
    need(same(processBefore, processAfter) && same(binding, await prepare({ sourcePath: binding.sourcePath, projectName: binding.projectName })), 'source-or-process-changed');
    need(same((await fs.readdir(path.dirname(binding.sourcePath))).sort(), ['Project.db']), 'source-sidecars-or-extra-files');
    // Do not let the final process/configuration observations conceal a source
    // mutation that happened after the second byte read. This remains an
    // observation, not OS-level exclusion of a subsequent external writer.
    const finalRead = await stableFile(binding.sourcePath, 128 * 1024 * 1024);
    need(finalRead.bytes.equals(readBefore.bytes) && same(finalRead.identity, readBefore.identity), 'source-changed');
    return { schemaVersion: 1, process: processAfter, source, configSha256: binding.configSha256,
      descriptorsBefore, descriptorsAfter, actualOpenFileBindingVerified: true, startedAt,
      checkedAt: now().toISOString(), concurrentWriterResistanceProven: false };
  }
  return { prepare, observe };
}

const sourceBinding = createClosedProjectSourceBinding();
module.exports = { createClosedProjectSourceBinding, parseDiskLibraryConfig, parseResolveOpenFiles,
  prepareClosedProjectSourceBinding: options => sourceBinding.prepare(options),
  observeLoadedProjectSource: options => sourceBinding.observe(options) };
