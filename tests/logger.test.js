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
    items: [{ filename: '[REDACTED]', label: '[REDACTED]' }]
  });
});

test('preserves ordinary diagnostic values', () => {
  assert.deepEqual(redact({ format: 'FCPXML', attempt: 2, enabled: false }), {
    format: 'FCPXML', attempt: 2, enabled: false
  });
});

test('redacts paths and addresses embedded in otherwise ordinary messages', () => {
  assert.deepEqual(redact({ note: 'Could not read /Users/editor/cut.fcpxml',
    detail: 'https://example.test/download?token=secret', contact: 'editor@example.test',
    mediaName: 'take-01.mov' }), {
    note: '[LOCAL_PATH]', detail: '[LOCAL_PATH]', contact: '[REDACTED]', mediaName: '[REDACTED]'
  });
});

test('opaque credentials and path-free filenames are rejected even under innocuous field names',()=>{
 assert.deepEqual(redact({code:'BearerOpaqueCredential-123',note:'take-01.mov',label:'private-client-codename'}),{code:'unknown-error',note:'[REDACTED]',label:'[REDACTED]'});
});

test('log output uses closed event and field catalogs rather than raw errors or arbitrary fields',()=>{
 const logger=require('../src/logger'),lines=[],original=console.warn;console.warn=value=>lines.push(JSON.parse(value));
 try{
  logger.warn('project.scan-failed',{code:'BearerOpaqueCredential-123',note:'take-01.mov',timestamp:'private',event:'private',email:'private@example.test'});
  logger.warn('native-secret-event-123',{code:'file-unavailable',credential:'opaque'});
  logger.warn('project.scan-failed',{code:'file-unavailable',stack:'private-client-codename'});
 }finally{console.warn=original;}
 assert.equal(lines[0].event,'project.scan-failed');assert.equal(lines[0].code,'unknown-error');assert.equal(lines[0].level,'warn');
 assert.deepEqual(Object.keys(lines[0]).sort(),['code','event','level','timestamp']);
 assert.equal(lines[1].event,'unknown-event');assert.equal(Object.hasOwn(lines[1],'code'),false);
 assert.equal(lines[2].code,'file-unavailable');assert.doesNotMatch(JSON.stringify(lines),/BearerOpaque|take-01|private|opaque|credential/);
});

test('scan counts and known app versions remain useful while saved revision identities are omitted',()=>{
 const logger=require('../src/logger'),lines=[],original=console.info;console.info=value=>lines.push(JSON.parse(value));
 try{logger.info('project.scan-complete',{clipCount:50,warningCount:2,filePath:'/private/client'});logger.info('revision.saved',{projectId:'private-client',revisionId:'secret-revision'});logger.info('app.ready',{version:'0.1.0'});}finally{console.info=original;}
 assert.equal(lines[0].clipCount,50);assert.equal(lines[0].warningCount,2);assert.equal(lines[2].version,'0.1.0');assert.doesNotMatch(JSON.stringify(lines),/private|secret-revision|projectId|revisionId/);
});
