'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { acceptConsoleOutput, createNextChunkCommand } = require('../src/resolve-console-transfer');

const requestId = 'a'.repeat(32);
const requestSha256 = 'b'.repeat(64);
const part = (id, index, total, data) =>
  `Console output\nFRAMELINE_CAPTURE_CHUNK_V1:${id}:${index}:${total}:${data}\n`;

test('Console transfer assembles ordered chunks and creates a bound next command', () => {
  const first = acceptConsoleOutput({ output: part(requestId, 1, 3, '{"x":"'),
    requestId, requestSha256 });
  assert.equal(first.complete, false);
  assert.equal(first.nextIndex, 2);
  assert.match(first.command, /FRAMELINE_CAPTURE_BUFFER_V1/);
  assert.match(first.command, new RegExp(requestSha256));
  const second = acceptConsoleOutput({ output: part(requestId, 2, 3, 'café'),
    requestId, requestSha256, transfer: first.transfer });
  const last = acceptConsoleOutput({ output: part(requestId, 3, 3, '"}'),
    requestId, requestSha256, transfer: second.transfer });
  assert.deepEqual(last, { complete: true, responseText: '{"x":"café"}' });
});

test('Console transfer rejects cross-request, reordered, duplicated, and changed-total parts', () => {
  const first = acceptConsoleOutput({ output: part(requestId, 1, 2, 'one'),
    requestId, requestSha256 });
  for (const output of [
    part('c'.repeat(32), 2, 2, 'two'),
    part(requestId, 1, 2, 'one'),
    part(requestId, 3, 3, 'three'),
    part(requestId, 2, 3, 'two'),
    'FRAMELINE_CAPTURE_ERROR_V1:Capture buffer unavailable or expired'
  ]) {
    assert.throws(() => acceptConsoleOutput({ output, requestId, requestSha256,
      transfer: first.transfer }), { code: 'resolve-console-transfer-invalid' });
  }
  assert.throws(() => createNextChunkCommand({ requestId, requestSha256, index: 1 }),
    { code: 'resolve-console-transfer-invalid' });
});

test('Console transfer retains the single-result path for small captures', () => {
  assert.deepEqual(acceptConsoleOutput({ output: 'FRAMELINE_CAPTURE_RESULT_V1:{"ok":true}',
    requestId, requestSha256 }), { complete: true, responseText: '{"ok":true}' });
});
