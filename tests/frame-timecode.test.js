'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatFrameTimecode: format, SUPPORTED_RATES } = require('../src/frame-timecode');

test('unknown source rate keeps exact frame coordinates without invented SMPTE', () => {
  assert.equal(format(86472, { originFrame: 86400 }), 'Frame 86472 · timeline +72f; SMPTE unavailable (frame rate not captured)');
  assert.match(format(0), /Frame 0.*\+0f.*frame rate not captured/);
  assert.equal(format(null), 'Frame not observed; timecode unavailable');
  assert.equal(format(Number.MAX_SAFE_INTEGER + 1), 'Frame not observed; timecode unavailable');
  assert.match(format(2, { rate: '24', originFrame: null }), /origin not observed/);
});
test('explicit rate enables nominal non-drop display with provenance and no guessed rounding', () => {
  assert.match(format(86472, { rate: '24', originFrame: 86400 }), /00:00:03:00 NDF \(24 fps, user-selected display rate\)/);
  assert.match(format(30, { rate: '30000/1001' }), /00:00:01:00 NDF \(30000\/1001 fps, user-selected display rate\)/);
  assert.match(format(24, { rate: '24000/1001' }), /00:00:01:00 NDF/);
  assert.match(format(60, { rate: '60000/1001' }), /00:00:01:00 NDF/);
  for (const rate of SUPPORTED_RATES) assert.match(format(100, { rate }), /NDF/);
});
test('BigInt arithmetic preserves safe frame boundaries, negative offsets and unlimited hours', () => {
  assert.match(format(9, { originFrame: 10, rate: '24' }), /timeline -1f.*-00:00:00:01 NDF/);
  assert.match(format(24 * 60 * 60 * 100, { rate: '24' }), /100:00:00:00 NDF/);
  const value = Number.MAX_SAFE_INTEGER;
  const result = format(value, { originFrame: -value, rate: '24' });
  assert.match(result, /timeline \+18014398509481982f/);
  const frames = BigInt(value) * 2n;
  assert(result.includes(`:${String(frames % 24n).padStart(2, '0')} NDF`));
});
test('invalid settings never silently choose a timebase or emit unsafe values', () => {
  assert.match(format(10, { rate: '29.97' }), /unsupported display rate/);
  assert.match(format(10, { rate: 24 }), /unsupported display rate/);
  assert.match(format(10, { originFrame: 1.5 }), /origin not observed/);
  assert.match(format(10, { unexpected: true }), /invalid display settings/);
  assert.match(format(10, null), /invalid display settings/);
  assert(!format(10, { rate: '/private/secret' }).includes('private'));
});
test('same API is available to the isolated browser renderer without Node globals', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frame-timecode.js'), 'utf8'), context);
  assert.equal(context.FrameTimecode.formatFrameTimecode(24, { rate: '24' }), format(24, { rate: '24' }));
  assert.equal(Object.isFrozen(context.FrameTimecode), true);
});
