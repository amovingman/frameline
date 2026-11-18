'use strict';
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 8000 }, fn);
const assert = require('node:assert/strict');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { createSmtpNotificationSender } = require('../src/smtp-notification-sender');

// Public test certificates only. Trust is added per socket in this test worker;
// production TLS verification and the machine's trust configuration stay intact.
const fixtureDirectory = path.join(__dirname, 'fixtures/network-tls');
const ca = fs.readFileSync(path.join(fixtureDirectory, 'ca.pem'));
const cert = fs.readFileSync(path.join(fixtureDirectory, 'server.pem'));
const key = fs.readFileSync(path.join(fixtureDirectory, 'server-key.pem'));
const originalConnect = tls.connect;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const syntheticToken = Buffer.alloc(32, 19).toString('base64url');
function payload(patch = {}) { return { jobId: 'email-job-1', messageId: 'a'.repeat(64), to: 'recipient@example.test', projectName: 'Été 夜',
  eventCount: 3, permissionLossCount: 0, unsubscribeToken: syntheticToken, kind: 'daily',
  counts: { 'revision.created': 2, 'share.created': 1 }, throughAt: 1_800_000_000_000, ...patch }; }
async function fixture(t, options = {}) {
  const sockets = new Set(), commands = [], messages = [], connectionOptions = [], senders = [];
  let rawConnections = 0;
  const server = tls.createServer({ key, cert, minVersion: 'TLSv1.2' }, socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8');
    let buffer = '', inData = false;
    if (options.greeting !== null) socket.write(options.greeting ?? '220 fixture.example ESMTP\r\n');
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.length) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n'); if (end < 0) return;
          const message = buffer.slice(0, end + 2); buffer = buffer.slice(end + 5); inData = false; messages.push(message);
          if (options.message?.(message, socket) === true) continue;
          socket.write('250 queued\r\n'); continue;
        }
        const end = buffer.indexOf('\r\n'); if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); commands.push(line);
        if (options.command?.(line, socket) === true) continue;
        if (line.startsWith('EHLO ')) socket.write(options.ehloReply ?? '250-fixture.example\r\n250-AUTH PLAIN\r\n250 SIZE 32768\r\n');
        else if (line.startsWith('AUTH PLAIN ')) socket.write('235 authenticated\r\n');
        else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 accepted\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 end with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 goodbye\r\n');
        else socket.write('500 unknown command\r\n');
      }
    });
  });
  server.on('tlsClientError', () => {});
  server.on('connection', socket => { rawConnections++; sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  t.after(async () => {
    for (const sender of senders) sender.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  t.mock.method(tls, 'connect', function(observed) {
    connectionOptions.push({ ...observed });
    return originalConnect.call(tls, options.trusted === false ? observed : { ...observed, ca });
  });
  const config = { publicOrigin: 'https://updates.example.test', from: 'updates@example.test',
    smtp: { host: '127.0.0.1', port: server.address().port, username: options.auth ? 'fixture-user' : null, password: options.auth ? 'fixture-password' : null } };
  const create = (patch = {}) => { const sender = createSmtpNotificationSender({ config, timeoutMs: 1000, now: () => 1_800_000_010_000, ...patch }); senders.push(sender); return sender; };
  return { config, create, commands, messages, connectionOptions, get rawConnections() { return rawConnections; } };
}
async function rejects(promise, code, retryable = false) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, code); assert.equal(error.retryable, retryable);
    assert.equal(error.message, code); assert.doesNotMatch(error.message, /fixture-password|private-provider|\/private|recipient@example/); return true;
  });
}
function decode(message) {
  const [headers, body] = message.split('\r\n\r\n'); return { headers, encoded: body, body: Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8') };
}

test('actual TLS SMTP accepts multiline EHLO and emits bounded Unicode plain MIME with stable identity and fragment unsubscribe', async t => {
  const f = await fixture(t), sender = f.create();
  assert.deepEqual(await sender.send(payload()), { accepted: true }); assert.deepEqual(await sender.send(payload()), { accepted: true });
  assert.equal(f.messages.length, 2); assert.equal(f.commands.filter(line => line.startsWith('AUTH')).length, 0);
  assert.deepEqual(f.commands.filter(line => line !== 'QUIT').slice(0, 4), ['EHLO frameline.local', 'MAIL FROM:<updates@example.test>', 'RCPT TO:<recipient@example.test>', 'DATA']);
  for (const options of f.connectionOptions) { assert.equal(options.rejectUnauthorized, true); assert.equal(options.minVersion, 'TLSv1.2'); assert.equal(options.servername, undefined); }
  const message = decode(f.messages[0]); assert.match(message.headers, /Content-Type: text\/plain; charset=UTF-8/); assert.match(message.headers, /Content-Transfer-Encoding: base64/);
  assert.match(message.headers, new RegExp(`Message-ID: <${'a'.repeat(64)}@updates.example.test>`));
  assert.equal(decode(f.messages[1]).headers.match(/Message-ID: .*/)[0], message.headers.match(/Message-ID: .*/)[0]);
  assert.match(message.body, /Project: Été 夜/); assert.match(message.body, /Daily digest \(UTC\)/); assert.match(message.body, /New revisions: 2/); assert.match(message.body, /Created share links: 1/);
  assert.match(message.body, new RegExp(`https://updates.example.test/unsubscribe#${syntheticToken}`));
  assert.doesNotMatch(message.body, /\?token=|Pan=|sourcePath|manifestId|Camera-A-003/); assert.doesNotMatch(message.headers, /multipart|attachment|Bcc:/i);
  assert(message.encoded.trim().split('\r\n').every(line => line.length <= 76)); assert(Buffer.byteLength(f.messages[0]) < 32768);
});

test('optional AUTH PLAIN is sent only over verified TLS when advertised', async t => {
  const f = await fixture(t, { auth: true }); assert.deepEqual(await f.create().send(payload({ kind: 'immediate' })), { accepted: true });
  const command = f.commands.find(line => line.startsWith('AUTH PLAIN ')); assert.equal(Buffer.from(command.slice(11), 'base64').toString('utf8'), '\0fixture-user\0fixture-password');
  assert.match(decode(f.messages[0]).headers, /Subject: Frameline project updates/);
  assert.equal(f.connectionOptions[0].rejectUnauthorized, true);
});

test('missing PLAIN capability and rejected auth fail safely without envelope or provider text', async t => {
  await t.test('missing', async t => {
    const f = await fixture(t, { auth: true, ehloReply: '250 fixture.example SIZE 32768\r\n' });
    await rejects(f.create().send(payload()), 'smtp-auth-unavailable'); assert.equal(f.commands.some(line => line.startsWith('AUTH') || line.startsWith('MAIL')), false);
  });
  await t.test('rejected', async t => {
    const f = await fixture(t, { auth: true, command(line, socket) { if (line.startsWith('AUTH')) { socket.write('535 /private-provider fixture-password rejected\r\n'); return true; } } });
    await rejects(f.create().send(payload()), 'smtp-auth-failed'); assert.equal(f.commands.some(line => line.startsWith('MAIL')), false);
  });
});

test('untrusted certificates and trusted certificate/name mismatch are refused with verification enabled', async t => {
  await t.test('untrusted', async t => {
    const f = await fixture(t, { trusted: false }); await rejects(f.create().send(payload()), 'smtp-tls-unavailable', true);
    assert.equal(f.commands.length, 0); assert.equal(f.connectionOptions[0].rejectUnauthorized, true);
  });
  await t.test('hostname', async t => {
    const f = await fixture(t); f.config.smtp.host = 'localhost'; await rejects(f.create().send(payload()), 'smtp-tls-unavailable', true);
    assert.equal(f.rawConnections, 1); assert.equal(f.commands.length, 0); assert.equal(f.connectionOptions[0].servername, 'localhost'); assert.equal(f.connectionOptions[0].rejectUnauthorized, true);
  });
});

test('definite SMTP rejections distinguish permanent 5xx from retryable 4xx without claiming acceptance', async t => {
  for (const [reply, code, retryable] of [['550 recipient rejected', 'smtp-rejected', false], ['451 retry later', 'smtp-transient-failure', true]]) await t.test(reply.slice(0, 3), async t => {
    const f = await fixture(t, { command(line, socket) { if (line.startsWith('RCPT')) { socket.write(`${reply}\r\n`); return true; } } });
    await rejects(f.create().send(payload()), code, retryable); assert.equal(f.commands.includes('DATA'), false); assert.equal(f.messages.length, 0);
  });
});

test('malformed, oversized and inconsistent replies are rejected as protocol failures', async t => {
  for (const [label, greeting] of [['bare-LF', '220 fixture\n'], ['too-long', `220 ${'x'.repeat(511)}\r\n`], ['inconsistent', '220-first\r\n250 changed code\r\n'],
    ['too-many-lines', `${'220-line\r\n'.repeat(65)}220 end\r\n`], ['oversized-stream', 'x'.repeat(65537)]]) await t.test(label, async t => {
    const f = await fixture(t, { greeting }); await rejects(f.create().send(payload()), 'smtp-protocol-invalid'); assert.equal(f.messages.length, 0);
  });
});

test('fragmented multiline responses remain readable without relaxing reply code validation', async t => {
  const f = await fixture(t, { command(line, socket) {
    if (line.startsWith('EHLO')) { socket.write('250-fixture.example\r\n250-A'); setImmediate(() => socket.write('UTH PLAIN\r\n250 SIZE 32768\r\n')); return true; }
  } });
  assert.deepEqual(await f.create().send(payload()), { accepted: true }); assert.equal(f.messages.length, 1);
});

test('network loss after DATA and missing final acknowledgment are delivery-uncertain and retryable', async t => {
  await t.test('dropped acknowledgment', async t => {
    const f = await fixture(t, { message(_message, socket) { socket.destroy(); return true; } });
    await rejects(f.create().send(payload()), 'smtp-delivery-uncertain', true); assert.equal(f.messages.length, 1);
  });
  await t.test('timed-out acknowledgment', async t => {
    const f = await fixture(t, { message() { return true; } });
    await rejects(f.create({ timeoutMs: 500 }).send(payload()), 'smtp-delivery-uncertain', true); assert.equal(f.messages.length, 1);
  });
});

test('beforeData reauthorization can suppress delivery or replace private project details with generic permission counts', async t => {
  await t.test('suppressed', async t => {
    const f = await fixture(t); assert.equal(await f.create().send(payload(), { beforeData: async () => null }), null); assert.equal(f.commands.includes('DATA'), false); assert.equal(f.messages.length, 0);
  });
  await t.test('reprepared', async t => {
    const f = await fixture(t); const fresh = payload({ projectName: null, eventCount: 1, permissionLossCount: 1, counts: { 'member.removed': 1 } });
    assert.deepEqual(await f.create().send(payload(), { beforeData: async () => fresh }), { accepted: true });
    const body = decode(f.messages[0]).body; assert.match(body, /Your project access changed/); assert.match(body, /Access changes: 1/); assert.doesNotMatch(body, /Été 夜|Project:/);
  });
  for (const field of ['to', 'jobId', 'messageId']) await t.test(`immutable-${field}`, async t => {
    const f = await fixture(t); const fresh = payload({ [field]: field === 'to' ? 'different@example.test' : field === 'messageId' ? 'b'.repeat(64) : 'different-job' });
    await rejects(f.create().send(payload(), { beforeData: async () => fresh }), 'smtp-message-invalid'); assert.equal(f.commands.includes('DATA'), false);
  });
  await t.test('preparation-failed', async t => {
    const f = await fixture(t); await rejects(f.create().send(payload(), { beforeData() { throw new Error('/private-provider'); } }), 'smtp-preparation-unavailable', true); assert.equal(f.messages.length, 0);
  });
});

test('abort, pre-DATA timeout and sender close retire owned sockets without sending a message', async t => {
  await t.test('abort', async t => {
    const entered = deferred(), f = await fixture(t, { command(line) { if (line.startsWith('MAIL')) { entered.resolve(); return true; } } });
    const controller = new AbortController(), sending = f.create().send(payload(), { signal: controller.signal }); await entered.promise; controller.abort();
    await rejects(sending, 'smtp-cancelled', true); assert.equal(f.commands.includes('DATA'), false);
  });
  await t.test('timeout', async t => { const f = await fixture(t, { greeting: null }); await rejects(f.create({ timeoutMs: 500 }).send(payload()), 'smtp-timeout', true); assert.equal(f.commands.length, 0); });
  await t.test('close', async t => {
    const entered = deferred(), f = await fixture(t, { command(line) { if (line.startsWith('MAIL')) { entered.resolve(); return true; } } }), sender = f.create();
    const sending = sender.send(payload()); await entered.promise; sender.close();
    await assert.rejects(sending, error => error.retryable === true && ['smtp-network-unavailable', 'smtp-cancelled'].includes(error.code));
    await rejects(sender.send(payload()), 'smtp-cancelled', true); assert.equal(f.commands.includes('DATA'), false);
  });
});

test('malformed or private-field input and pre-aborted work never start a TLS connection', async t => {
  const f = await fixture(t), sender = f.create();
  for (const invalid of [payload({ to: 'recipient@example.test\r\nBcc: attacker@example.test' }), payload({ projectName: 'Bad\r\nHeader' }),
    payload({ messageId: 'not-hash' }), payload({ counts: { 'revision.created': 2 } }), payload({ counts: { 'clip.secret': 3 } }),
    payload({ unsubscribeToken: 'not-canonical' }), { ...payload(), clipName: 'Camera-A-003' }, payload({ permissionLossCount: 4 })]) {
    await rejects(sender.send(invalid), 'smtp-message-invalid');
  }
  const controller = new AbortController(); controller.abort(); await rejects(sender.send(payload(), { signal: controller.signal }), 'smtp-cancelled', true);
  assert.equal(f.connectionOptions.length, 0); assert.equal(f.rawConnections, 0);
});
