'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createClosedProjectSourceBinding, parseDiskLibraryConfig, parseResolveOpenFiles }
  = require('../src/closed-project-apply-source-binding');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PROCESS = ' 22 Fri Nov 20 10:00:00 2026 /Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve\n';

async function fixture(t, overrides = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-source-bind-')));
  await fs.chmod(root, 0o700); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'Library'), configPath = path.join(root, 'dblist.conf'), projectName = 'Owned project';
  const project = path.join(libraryRoot, 'Resolve Projects', 'Users', 'guest', 'Projects', projectName);
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(project, 'Project.db'), bytes = Buffer.from('private candidate database');
  await fs.writeFile(sourcePath, bytes, { mode: 0o600 });
  await fs.writeFile(configPath, `Local Database:${libraryRoot}:*:::DISK\n`, { mode: 0o600 });
  const stat = await fs.stat(sourcePath);
  const lsof = `p22\nfcwd\ntDIR\nD0x${stat.dev.toString(16)}\ni1\nn/\nf16\ntREG\nD0x${stat.dev.toString(16)}\ni${stat.ino}\nn${sourcePath}\n`;
  let psCount = 0, lsofCount = 0;
  const execFile = async (file, args, options) => {
    assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.shell, undefined);
    if (file === '/bin/ls') return { stdout: 'drwx------+ 1 owner staff 52 Nov 20 09:15 private\n 0: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C deny delete\n', stderr: '' };
    if (file === '/bin/ps') {
      psCount++; return overrides.ps ? overrides.ps(psCount) : { stdout: PROCESS, stderr: '' };
    }
    assert.equal(file, '/usr/sbin/lsof'); assert.deepEqual(args, ['-nP', '-a', '-p', '22', '-F', 'pftDin']);
    lsofCount++; return overrides.lsof ? overrides.lsof(lsof, lsofCount, { sourcePath, configPath, libraryRoot }) : { stdout: lsof, stderr: '' };
  };
  const api = createClosedProjectSourceBinding({ execFile, configPath, platform: 'darwin' });
  return { api, root, libraryRoot, configPath, projectName, sourcePath, expectedSha256: hash(bytes), stat, lsof };
}

test('binds one configured root-level Disk project and the actual Resolve descriptor twice', async t => {
  const f = await fixture(t), binding = await f.api.prepare(f);
  assert.deepEqual(binding.expectedCurrentDatabase, { DbType: 'Disk', DbName: 'Local Database' });
  assert.equal(binding.expectedCurrentFolder, 'Root');
  const result = await f.api.observe({ binding, expectedSha256: f.expectedSha256 });
  assert.equal(result.actualOpenFileBindingVerified, true);
  assert.equal(result.source.path, f.sourcePath);
  assert.equal(result.source.inode, String(f.stat.ino));
  assert.equal(result.source.device, String(f.stat.dev));
  assert.equal(result.source.sha256, f.expectedSha256);
  assert.equal(result.process.pid, 22);
  assert.equal(result.descriptorsBefore, 1); assert.equal(result.descriptorsAfter, 1);
  assert.equal(result.concurrentWriterResistanceProven, false);
});

test('configuration parser rejects ambiguous, escaped, remote and malformed libraries', () => {
  for (const text of ['Local:/one:*:::DISK\nLocal:/two::::DISK\n', 'One:/same:*:::DISK\nTwo:/same::::DISK\n',
    'Local:/a/../b:*:::DISK\n', 'Local:/some:colon:*:::DISK\n', 'Local:host:*:::POSTGRESQL\n',
    'Local:/a:*:::DISK', 'Local:/a:*:::DISK\n\n']) {
    assert.throws(() => parseDiskLibraryConfig(Buffer.from(text)), /configuration/);
  }
});

test('Resolve writable configuration requires a protected owned private ancestor', async t => {
  const f = await fixture(t);
  await fs.chmod(f.configPath, 0o666);
  assert.equal((await f.api.prepare(f)).expectedCurrentDatabase.DbName, 'Local Database');
  assert.equal((await fs.stat(f.configPath)).mode & 0o7777, 0o666);
});

test('non-root projects, renamed configured library and symlinked config are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.prepare({ ...f, projectName: 'Different project' }), /root-project-library-unbound/);
  const nested = path.join(path.dirname(f.sourcePath), 'nested'); await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'Project.db'), 'copy', { mode: 0o600 });
  await assert.rejects(f.api.prepare({ ...f, sourcePath: path.join(nested, 'Project.db') }), /root-project-library-unbound/);
  const binding = await f.api.prepare(f);
  await fs.writeFile(f.configPath, `Renamed library:${f.libraryRoot}:*:::DISK\n`);
  await assert.rejects(f.api.observe({ binding, expectedSha256: f.expectedSha256 }), /configuration-changed/);
  const copy = path.join(f.root, 'real.conf'); await fs.rename(f.configPath, copy); await fs.symlink(copy, f.configPath);
  await assert.rejects(f.api.prepare(f), /canonical-file-required/);
});

test('actual open descriptor must name the selected inode, not merely a copied matching UUID database', async t => {
  for (const transform of [s => s.replace(/\ni[0-9]+\nn[^\n]+Project\.db/, '\ni123456\nn/other/Project.db'),
    s => s.replace(/\ni[0-9]+\nn([^\n]+Project\.db)/, '\ni123456\nn$1'),
    s => s.replace(/Project\.db\n$/, 'Project.db (deleted)\n'),
    s => s.slice(0, s.indexOf('\nf16')) + '\n']) {
    const f = await fixture(t, { lsof: async value => ({ stdout: transform(value), stderr: '' }) });
    await assert.rejects(f.api.observe({ binding: await f.api.prepare(f), expectedSha256: f.expectedSha256 }), /open-project/);
  }
});

test('multiple descriptors to the selected inode are allowed, a second project is refused', async t => {
  const sameFile = await fixture(t, { lsof: async value => ({ stdout: value + value.slice(value.indexOf('f16')).replace('f16', 'f17'), stderr: '' }) });
  const good = await sameFile.api.observe({ binding: await sameFile.api.prepare(sameFile), expectedSha256: sameFile.expectedSha256 });
  assert.equal(good.descriptorsBefore, 2);
  const otherFile = await fixture(t, { lsof: async value => ({ stdout: value
    + 'f17\ntREG\nD0x1000012\ni99999\nn/other/Project.db\n', stderr: '' }) });
  await assert.rejects(otherFile.api.observe({ binding: await otherFile.api.prepare(otherFile), expectedSha256: otherFile.expectedSha256 }), /open-project-source-differs/);
});

test('PID reuse, a second Resolve and blocked open-file observation cannot provide admission', async t => {
  for (const ps of [async count => ({ stdout: count === 1 ? PROCESS : PROCESS.replace('10:00:00', '10:00:01'), stderr: '' }),
    async () => ({ stdout: PROCESS + PROCESS.replace(' 22 ', ' 23 '), stderr: '' })]) {
    const f = await fixture(t, { ps });
    await assert.rejects(f.api.observe({ binding: await f.api.prepare(f), expectedSha256: f.expectedSha256 }), /source-or-process-changed|resolve-process-ambiguous/);
  }
  const blocked = await fixture(t, { lsof: async () => { throw new Error('Permission denied'); } });
  await assert.rejects(blocked.api.observe({ binding: await blocked.api.prepare(blocked), expectedSha256: blocked.expectedSha256 }), /observer-unavailable/);
});

test('the installed IO XPC helper is distinguished from a second or alternate Resolve main process', async t => {
  const helper = ' 23 Fri Nov 20 10:00:00 2026 /Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/XPCServices/IOXPC.xpc/Contents/MacOS/IOXPC\n';
  const f = await fixture(t, { ps: async () => ({ stdout: PROCESS + helper, stderr: '' }) });
  const result = await f.api.observe({ binding: await f.api.prepare(f), expectedSha256: f.expectedSha256 });
  assert.equal(result.process.pid, 22);
  for (const extra of [PROCESS.replace(' 22 ', ' 24 '),
    ' 24 Fri Nov 20 10:00:00 2026 /Volumes/Another/Resolve\n', helper.replace('/IOXPC.xpc/', '/Unknown.xpc/')]) {
    const invalid = await fixture(t, { ps: async () => ({ stdout: PROCESS + extra, stderr: '' }) });
    await assert.rejects(invalid.api.observe({ binding: await invalid.api.prepare(invalid), expectedSha256: invalid.expectedSha256 }), /resolve-process-ambiguous/);
  }
});

test('source mutation, sidecars and configuration edits during the barrier refuse admission', async t => {
  for (const mutationAt of [1, 2]) {
    const mutation = await fixture(t, { lsof: async (value, count, context) => {
      if (count === mutationAt) await fs.writeFile(context.sourcePath, 'a different source');
      return { stdout: value, stderr: '' };
    } });
    await assert.rejects(mutation.api.observe({ binding: await mutation.api.prepare(mutation), expectedSha256: mutation.expectedSha256 }), /source-changed/);
  }
  const sidecar = await fixture(t); await fs.writeFile(sidecar.sourcePath + '-wal', 'wal');
  await assert.rejects(sidecar.api.observe({ binding: await sidecar.api.prepare(sidecar), expectedSha256: sidecar.expectedSha256 }), /source-sidecars-or-extra-files/);
  const config = await fixture(t, { lsof: async (value, count, context) => {
    if (count === 1) await fs.writeFile(context.configPath, `Renamed:${context.libraryRoot}:*:::DISK\n`);
    return { stdout: value, stderr: '' };
  } });
  await assert.rejects(config.api.observe({ binding: await config.api.prepare(config), expectedSha256: config.expectedSha256 }), /source-or-process-changed/);
});

test('lsof parser rejects process substitution, malformed records and unknown fields', () => {
  for (const output of ['p23\n', 'f1\ntREG\n', 'p22\nf1\nxunknown\n', 'p22\np22\n',
    'p22\nf1\ntREG\nDwrong\ni1\nn/one/Project.db\n']) {
    assert.throws(() => parseResolveOpenFiles(output, 22), /open-files|open-project/);
  }
});
