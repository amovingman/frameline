'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runVendorLuaMock } = require('../phase-0/run-vendor-lua-mock');
const library = '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/libluajit-5.1.2.dylib';
test('mock transport rejects oversized or invalid source before spawning', () => {
  assert.throws(() => runVendorLuaMock(''));
  assert.throws(() => runVendorLuaMock('a\0b'));
  assert.throws(() => runVendorLuaMock(Buffer.alloc(4 * 1024 * 1024 + 1, 32)));
  assert.throws(() => runVendorLuaMock('print(1)', { timeout: 0 }));
});
test('vendor mock receives regular stdin with EOF, unchanged language semantics, and unchanged execution failures',
  { skip: !fs.existsSync(library) && 'Vendor Lua unavailable' }, () => {
    const source = '--' + ' '.repeat(256 * 1024) + '\nassert(io.stdin:seek("cur")~=nil,"stdin must be a regular file");print("regular-fd-ok")';
    const run = runVendorLuaMock(source, { library });
    assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /regular-fd-ok/);
    const failed = runVendorLuaMock('error("synthetic failure")', { library });
    assert.equal(failed.status, 1); assert.equal(failed.stderr, 'lua-observation-mock-failed\n');
  });
