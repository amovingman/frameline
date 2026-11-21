'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createHash } = require('node:crypto');
const sdk = require('@aws-sdk/client-s3');
const { createS3BackupTransport } = require('../src/cloud-backup-s3');

const bytes = Buffer.from('{"fixture":true}');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const key = `frameline-backups/v1/${sha256}.json`, prefix = 'frameline-backups/v1/';
const checksum = Buffer.from(sha256, 'hex').toString('base64');
const factory = send => createS3BackupTransport({ region: 'ca-central-1', bucket: 'portfolio-fixture', client: { send } });
const response = (extra = {}) => ({ Body: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]), ContentLength: bytes.length,
  Metadata: { 'backup-sha256': sha256 }, ChecksumSHA256: checksum, ...extra });

test('production S3 client fixes the AWS HTTPS endpoint and bounded retries without embedding credentials', () => {
  let configured, destroyed = false;
  const transport = createS3BackupTransport({ region: 'ca-central-1', bucket: 'portfolio-fixture', sdk: { ...sdk,
    S3Client: class { constructor(config) { configured = config; } send() {} destroy() { destroyed = true; } } } });
  assert.equal(configured.endpoint, 'https://s3.ca-central-1.amazonaws.com');
  assert.equal(configured.region, 'ca-central-1');
  assert.equal(configured.followRegionRedirects, false);
  assert.equal(configured.maxAttempts, 1);
  assert.deepEqual(configured.requestHandler, { connectionTimeout: 5000, requestTimeout: 30_000 });
  assert.equal(Object.hasOwn(configured, 'credentials'), false);
  assert.equal(Object.hasOwn(configured, 'logger'), false);
  transport.close(); assert.equal(destroyed, true);
});

test('immutable upload sends official command, exact checksum, fixed metadata and a copied body', async () => {
  let called, release;
  const result = new Promise(resolve => { release = resolve; });
  const transport = factory((command, options) => { called = { command, options }; return result; });
  const original = Buffer.from(bytes);
  const uploading = transport.put({ key, bytes: original, sha256 });
  original.fill(0);
  assert(called.command instanceof sdk.PutObjectCommand);
  assert.deepEqual(called.command.input, { Bucket: 'portfolio-fixture', Key: key, Body: bytes,
    ContentLength: bytes.length, ContentType: 'application/json', IfNoneMatch: '*',
    ChecksumSHA256: checksum, Metadata: { 'backup-sha256': sha256 } });
  assert(called.options.abortSignal instanceof AbortSignal);
  release({ ChecksumSHA256: checksum });
  assert.deepEqual(await uploading, { uploaded: true });
});

test('invalid target, content identity or limits are refused before issuing an SDK request', async () => {
  let calls = 0;
  const transport = factory(async () => { calls++; return {}; });
  for (const values of [{ key: '../secret.json' }, { key: `frameline-backups/v1/${'a'.repeat(64)}.json` },
    { sha256: 'a'.repeat(64) }, { bytes: Buffer.from('changed') }, { bytes: 'json' },
    { bytes: Buffer.alloc(50 * 1024 * 1024 + 1) }, { signal: {} }]) {
    await assert.rejects(transport.put({ key, bytes, sha256, ...values }), { code: 'cloud-backup-invalid' });
  }
  for (const maxBytes of [1, 50 * 1024 * 1024 + 1, Infinity, NaN]) {
    await assert.rejects(transport.get({ key, maxBytes }), { code: 'cloud-backup-invalid' });
  }
  await assert.rejects(transport.get({ key: 'https://secret.example/file' }), { code: 'cloud-backup-invalid' });
  await assert.rejects(transport.list({ prefix: 'other/' }), { code: 'cloud-backup-invalid' });
  await assert.rejects(transport.list({ prefix, continuationToken: 'private\nlog' }), { code: 'cloud-backup-invalid' });
  assert.equal(calls, 0);
});

test('SDK acknowledgments cannot substitute an unrelated checksum or arbitrary successful value', async () => {
  for (const output of [null, 'success', { ChecksumSHA256: 'wrong' }]) {
    await assert.rejects(factory(async () => output).put({ key, bytes, sha256 }), { code: 'cloud-backup-invalid-response' });
  }
});

test('service failures retain only an allowlisted code and no remote strings, URLs, causes or keys', async () => {
  const cases = [
    [{ $metadata: { httpStatusCode: 403 } }, 'auth'],
    [{ name: 'CredentialsProviderError' }, 'auth'],
    [{ name: 'ExpiredToken' }, 'auth'],
    [{ $metadata: { httpStatusCode: 404 } }, 'not-found'],
    [{ name: 'PreconditionFailed' }, 'exists'],
    [{ $metadata: { httpStatusCode: 409 } }, 'conflict'],
    [{ name: 'AbortError' }, 'cancelled'],
    [{ name: 'RequestTimeout' }, 'timeout'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ name: 'BadDigest' }, 'invalid-response'],
    [{ name: 'UnrecognizedRemoteSecret' }, 'unavailable']
  ];
  for (const [values, suffix] of cases) {
    const remote = Object.assign(new Error('secret-token https://private.example /Users/private'), values);
    await assert.rejects(factory(async () => { throw remote; }).put({ key, bytes, sha256 }), error => {
      assert.equal(error.code, `cloud-backup-${suffix}`);
      assert.equal(error.message, error.code);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack), /secret-token|private\.example|\/Users\/private/);
      return true;
    });
  }
});

test('download consumes a bounded stream and verifies content identity instead of trusting ETag', async () => {
  let command;
  const transport = factory(async value => { command = value; return response({ ETag: 'untrusted-etag' }); });
  assert.deepEqual(await transport.get({ key, maxBytes: bytes.length }), bytes);
  assert(command instanceof sdk.GetObjectCommand);
  assert.deepEqual(command.input, { Bucket: 'portfolio-fixture', Key: key, ChecksumMode: 'ENABLED' });
  assert.deepEqual(await factory(async () => response({ ContentLength: undefined, Metadata: undefined, ChecksumSHA256: undefined })).get({ key }), bytes);
});

test('oversized declared and streamed bodies are stopped and their sockets destroyed', async () => {
  for (const declared of [true, false]) {
    const body = Readable.from([Buffer.alloc(40)]);
    await assert.rejects(factory(async () => response({ Body: body, ContentLength: declared ? 40 : undefined })).get({ key, maxBytes: 20 }),
    { code: 'cloud-backup-too-large' });
    assert.equal(body.destroyed, true);
  }
});

test('truncation, altered bytes, mismatched metadata and corrupt stream values never release a download', async () => {
  for (const replacement of [
    { ContentLength: bytes.length + 1 },
    { ContentLength: -1 },
    { Body: Readable.from([Buffer.from('{"fixture":false}')]), ContentLength: undefined },
    { Metadata: { 'backup-sha256': 'a'.repeat(64) } },
    { ChecksumSHA256: 'wrong' },
    { Body: Readable.from(['not-binary']), ContentLength: undefined }
  ]) {
    const output = response(replacement);
    await assert.rejects(factory(async () => output).get({ key }), { code: 'cloud-backup-invalid-response' });
    assert.equal(output.Body.destroyed, true);
  }
  const body = new Readable({ read() { this.destroy(new Error('private-stream-secret')); } });
  await assert.rejects(factory(async () => response({ Body: body })).get({ key }), { code: 'cloud-backup-unavailable' });
});

test('already cancelled sends and cancellation while a send stalls finish with a safe terminal error', async () => {
  let calls = 0;
  const transport = factory(() => { calls++; return new Promise(() => {}); });
  await assert.rejects(transport.put({ key, bytes, sha256, signal: AbortSignal.abort() }), { code: 'cloud-backup-cancelled' });
  assert.equal(calls, 0);
  const controller = new AbortController(), pending = transport.put({ key, bytes, sha256, signal: controller.signal });
  controller.abort(new Error('private-cancel-reason'));
  await assert.rejects(pending, { code: 'cloud-backup-cancelled' });
  assert.equal(calls, 1);
  await assert.rejects(transport.list({ prefix, signal: AbortSignal.abort(new DOMException('private', 'TimeoutError')) }), { code: 'cloud-backup-timeout' });
});

test('cancellation destroys a stalled response stream and does not wait for its next chunk', async () => {
  const controller = new AbortController();
  const body = new Readable({ read() {} });
  const pending = factory(async () => response({ Body: body })).get({ key, signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'cloud-backup-cancelled' });
  assert.equal(body.destroyed, true);
});

test('list emits a bounded page of only validated key, byte count and timestamp fields', async () => {
  let called;
  const transport = factory(async value => { called = value; return { Name: 'portfolio-fixture', Prefix: prefix,
    IsTruncated: true, NextContinuationToken: 'opaque-next', Contents: [{ Key: key, Size: bytes.length,
      LastModified: new Date('2026-11-21T12:00:00Z'), ETag: 'untrusted', Owner: { ID: 'private-owner' } }] }; });
  assert.deepEqual(await transport.list({ prefix, continuationToken: 'opaque-current' }), {
    items: [{ key, size: bytes.length, lastModified: '2026-11-21T12:00:00.000Z' }], continuationToken: 'opaque-next'
  });
  assert(called instanceof sdk.ListObjectsV2Command);
  assert.deepEqual(called.input, { Bucket: 'portfolio-fixture', Prefix: prefix, MaxKeys: 100, ContinuationToken: 'opaque-current' });
  assert.deepEqual(await factory(async () => ({})).list({ prefix }), { items: [], continuationToken: null });
});

test('malformed pages, foreign objects, oversized lists and unsafe pagination fail closed', async () => {
  const entry = { Key: key, Size: bytes.length };
  for (const output of [null, { IsTruncated: 'true' }, { Contents: {} }, { Contents: Array(101).fill(entry) },
    { Contents: [entry, entry] }, { Name: 'foreign-bucket' }, { Prefix: 'other/' },
    { Contents: [{ ...entry, Key: 'private/secret.json' }] }, { Contents: [{ ...entry, Size: 0 }] },
    { Contents: [{ ...entry, Size: Number.MAX_SAFE_INTEGER }] }, { Contents: [{ ...entry, LastModified: new Date('invalid') }] },
    { IsTruncated: true }, { IsTruncated: true, NextContinuationToken: 'same' },
    { IsTruncated: true, NextContinuationToken: 'x'.repeat(4097) },
    { IsTruncated: false, NextContinuationToken: 'unexpected' }
  ]) {
    await assert.rejects(factory(async () => output).list({ prefix, continuationToken: 'same' }), { code: 'cloud-backup-invalid-response' });
  }
});

test('invalid bucket aliases, endpoint-shaped names and noncommercial regions never construct a client', () => {
  for (const values of [{ region: 'https://private.example' }, { region: 'us-gov-west-1' }, { region: 'cn-north-1' },
    { bucket: 'https://private.example' }, { bucket: 'dot.bucket' }, { bucket: 'bucket--x-s3' },
    { bucket: 'xn--bucket' }, { bucket: 'sthree-bucket' }, { bucket: 'amzn-s3-demo-bucket' },
    { bucket: '-bucket' }, { bucket: 'BUCKET' }]) {
    assert.throws(() => createS3BackupTransport({ region: 'ca-central-1', bucket: 'portfolio-fixture', ...values }), { code: 'cloud-backup-invalid' });
  }
});
