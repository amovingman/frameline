'use strict';
// Test transport only. The Python reader and vendor Lua source are unchanged.
// A regular stdin descriptor guarantees EOF; large spawnSync input pipes have
// intermittently left the bounded Python read waiting forever on macOS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const defaultLibrary = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';

function runVendorLuaMock(source, { library = defaultLibrary, timeout = 15000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  if ((!Buffer.isBuffer(source) && typeof source !== 'string') || !path.isAbsolute(library)
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000
    || !Number.isSafeInteger(maxBuffer) || maxBuffer < 1024 || maxBuffer > 16 * 1024 * 1024) throw new Error('invalid-vendor-lua-mock-options');
  const bytes = Buffer.from(source);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024 || bytes.includes(0)) throw new Error('invalid-vendor-lua-mock-source');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frameline-vendor-lua-mock-'));
  fs.chmodSync(directory, 0o700);
  let descriptor;
  try {
    const filename = path.join(directory, 'source.lua');
    fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    return spawnSync('python3', [path.join(__dirname, 'run-lua-observation-mock.py'), library], {
      stdio: [descriptor, 'pipe', 'pipe'], encoding: 'utf8', timeout, maxBuffer
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { runVendorLuaMock };
