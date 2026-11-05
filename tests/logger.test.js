const test = require('node:test');
const assert = require('node:assert/strict');
const { redact } = require('../src/logger');

test('redacts absolute paths in values and path-like fields', () => {
  assert.deepEqual(redact({ filePath: '/Users/editor/cut.fcpxml', note: 'C:\\Projects\\cut.fcpxml' }), {
    filePath: '[REDACTED]',
    note: '[LOCAL_PATH]'
  });
});

test('redacts sensitive fields recursively, including arrays', () => {
  assert.deepEqual(redact({
    user: { email: 'editor@example.com', token: 'abc123' },
    items: [{ filename: 'cut.fcpxml', label: 'timeline' }]
  }), {
    user: { email: '[REDACTED]', token: '[REDACTED]' },
    items: [{ filename: '[REDACTED]', label: 'timeline' }]
  });
});

test('preserves ordinary diagnostic values', () => {
  assert.deepEqual(redact({ format: 'FCPXML', attempt: 2, enabled: false }), {
    format: 'FCPXML', attempt: 2, enabled: false
  });
});
