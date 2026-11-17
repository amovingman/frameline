'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');

const FILES = ['resolve-internal.py', 'resolve_snapshot.py', 'resolve-internal.lua'];
function fail() { const error = new Error('resolve-companion-install-invalid'); error.code = 'resolve-companion-install-invalid'; throw error; }
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.mode & 0o077) fail();
  return fs.realpath(directory);
}
async function verifyExisting(filename, expected) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size !== expected.length) fail();
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { if (!(await handle.readFile()).equals(expected)) fail(); }
  finally { await handle.close(); }
}

// Electron can read bundled files from its archive; Resolve's Python console
// needs ordinary files. Copy each immutable script pair to a private, hash-named
// user-data directory and refuse any existing file whose bytes differ.
async function installResolveCompanion({ bundledDirectory, dataDirectory } = {}) {
  if (!path.isAbsolute(bundledDirectory || '') || !path.isAbsolute(dataDirectory || '')) fail();
  let sources;
  try { sources = await Promise.all(FILES.map(name => fs.readFile(path.join(bundledDirectory, name)))); }
  catch { fail(); }
  const packageHash = sha(Buffer.concat(sources.map(bytes => Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]))));
  const root = await privateDirectory(dataDirectory);
  const version = await privateDirectory(path.join(root, packageHash));
  for (let index = 0; index < FILES.length; index++) {
    const filename = path.join(version, FILES[index]);
    try { await fs.writeFile(filename, sources[index], { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') fail(); await verifyExisting(filename, sources[index]); }
  }
  const requestsDirectory = await privateDirectory(path.join(version, 'requests'));
  return { scriptPath: path.join(version, FILES[0]), luaScriptPath: path.join(version, FILES[2]), requestsDirectory,
    packageSha256: packageHash };
}

module.exports = { installResolveCompanion };
