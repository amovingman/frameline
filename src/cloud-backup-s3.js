'use strict';

const { createHash } = require('node:crypto');

const PREFIX = 'frameline-backups/v1/';
const KEY = /^frameline-backups\/v1\/([a-f0-9]{64})\.json$/;
const MAX_BYTES = 50 * 1024 * 1024;
const PAGE_SIZE = 100;
const DEADLINE_MS = 60_000;
const CODES = new Set(['cloud-backup-auth', 'cloud-backup-not-found', 'cloud-backup-exists',
  'cloud-backup-conflict', 'cloud-backup-cancelled', 'cloud-backup-timeout', 'cloud-backup-too-large',
  'cloud-backup-invalid-response', 'cloud-backup-unavailable', 'cloud-backup-invalid']);
const error = code => Object.assign(new Error(code), { code });
const fail = code => { throw error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalize(caught) {
  if (CODES.has(caught?.code) && caught.message === caught.code) return error(caught.code);
  const name = caught?.name, status = caught?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || ['CredentialsProviderError', 'TokenProviderError', 'InvalidAccessKeyId', 'ExpiredToken', 'InvalidToken', 'SignatureDoesNotMatch'].includes(name)) return error('cloud-backup-auth');
  if (status === 404 || ['NoSuchKey', 'NoSuchBucket', 'NotFound'].includes(name)) return error('cloud-backup-not-found');
  if (status === 412 || name === 'PreconditionFailed') return error('cloud-backup-exists');
  if (status === 409 || ['ConditionalRequestConflict', 'OperationAborted'].includes(name)) return error('cloud-backup-conflict');
  if (name === 'AbortError') return error('cloud-backup-cancelled');
  if (['TimeoutError', 'RequestTimeout'].includes(name) || caught?.code === 'ETIMEDOUT') return error('cloud-backup-timeout');
  if (['BadDigest', 'InvalidDigest'].includes(name)) return error('cloud-backup-invalid-response');
  return error('cloud-backup-unavailable');
}

function abortError(signal) {
  return error(signal.reason?.name === 'TimeoutError' ? 'cloud-backup-timeout' : 'cloud-backup-cancelled');
}

// Covers both SDK sends and a stalled response stream; no remote error strings
// or SDK exception causes escape this boundary.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortError(signal));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function createS3BackupTransport({ region, bucket, client, sdk } = {}) {
  if (typeof region !== 'string' || !/^(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z]+-[1-9][0-9]?$/.test(region)
    || typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    || ['xn--', 'sthree-', 'amzn-s3-demo-'].some(start => bucket.startsWith(start))
    || /(?:-s3alias|--ol-s3|--x-s3|--table-s3)$/.test(bucket)) fail('cloud-backup-invalid');
  sdk ||= require('@aws-sdk/client-s3');
  for (const name of ['PutObjectCommand', 'GetObjectCommand', 'ListObjectsV2Command']) {
    if (typeof sdk[name] !== 'function') fail('cloud-backup-invalid');
  }
  const owned = !client;
  if (!client) {
    if (typeof sdk.S3Client !== 'function') fail('cloud-backup-invalid');
    // Explicit HTTPS endpoint prevents endpoint environment/shared-config
    // overrides from redirecting the credential-bearing request elsewhere.
    client = new sdk.S3Client({ region, endpoint: `https://s3.${region}.amazonaws.com`,
      followRegionRedirects: false, maxAttempts: 1, forcePathStyle: false,
      useAccelerateEndpoint: false, useDualstackEndpoint: false, useFipsEndpoint: false,
      useArnRegion: false, disableMultiregionAccessPoints: true,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30_000 },
      requestChecksumCalculation: 'WHEN_SUPPORTED', responseChecksumValidation: 'WHEN_SUPPORTED' });
  }
  if (typeof client.send !== 'function') fail('cloud-backup-invalid');
  async function operation(signal, action) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('cloud-backup-invalid');
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(DEADLINE_MS)]) : AbortSignal.timeout(DEADLINE_MS);
    try {
      if (combined.aborted) throw abortError(combined);
      return await action(combined);
    } catch (caught) {
      if (combined.aborted) throw abortError(combined);
      throw normalize(caught);
    }
  }
  const keyHash = key => {
    if (typeof key !== 'string' || !KEY.test(key)) fail('cloud-backup-invalid');
    return KEY.exec(key)[1];
  };
  const send = (command, signal) => abortable(client.send(command, { abortSignal: signal }), signal);
  return {
    async put({ key, bytes, sha256, signal } = {}) {
      const expected = keyHash(key);
      if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAX_BYTES
        || sha256 !== expected || digest(bytes) !== expected) fail('cloud-backup-invalid');
      const body = Buffer.from(bytes), checksum = Buffer.from(expected, 'hex').toString('base64');
      return operation(signal, async bounded => {
        const response = await send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body,
          ContentLength: body.length, ContentType: 'application/json', IfNoneMatch: '*',
          ChecksumSHA256: checksum, Metadata: { 'backup-sha256': expected } }), bounded);
        if (!object(response) || response.ChecksumSHA256 !== undefined && response.ChecksumSHA256 !== checksum) fail('cloud-backup-invalid-response');
        return { uploaded: true };
      });
    },
    async get({ key, maxBytes = MAX_BYTES, signal } = {}) {
      const expected = keyHash(key);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 2 || maxBytes > MAX_BYTES) fail('cloud-backup-invalid');
      return operation(signal, async bounded => {
        const response = await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }), bounded);
        const body = response?.Body;
        if (!object(response) || !body || typeof body[Symbol.asyncIterator] !== 'function') {
          if (typeof body?.destroy === 'function') body.destroy();
          fail('cloud-backup-invalid-response');
        }
        const abortBody = () => { if (typeof body.destroy === 'function') body.destroy(); };
        bounded.addEventListener('abort', abortBody, { once: true });
        let finished = false;
        try {
          if (response.ContentLength !== undefined && (!Number.isSafeInteger(response.ContentLength) || response.ContentLength < 2)) fail('cloud-backup-invalid-response');
          if (response.ContentLength > maxBytes) fail('cloud-backup-too-large');
          if (response.Metadata?.['backup-sha256'] !== undefined && response.Metadata['backup-sha256'] !== expected) fail('cloud-backup-invalid-response');
          if (response.ChecksumSHA256 !== undefined && response.ChecksumSHA256 !== Buffer.from(expected, 'hex').toString('base64')) fail('cloud-backup-invalid-response');
          const chunks = []; let length = 0;
          const iterator = body[Symbol.asyncIterator]();
          while (true) {
            const item = await abortable(iterator.next(), bounded);
            if (item.done) break;
            if (!(item.value instanceof Uint8Array)) fail('cloud-backup-invalid-response');
            length += item.value.byteLength;
            if (length > maxBytes) fail('cloud-backup-too-large');
            chunks.push(Buffer.from(item.value));
          }
          if (length < 2 || response.ContentLength !== undefined && length !== response.ContentLength) fail('cloud-backup-invalid-response');
          const bytes = Buffer.concat(chunks, length);
          if (digest(bytes) !== expected) fail('cloud-backup-invalid-response');
          finished = true;
          return bytes;
        } finally {
          bounded.removeEventListener('abort', abortBody);
          if (!finished) abortBody();
        }
      });
    },
    async list({ prefix, continuationToken = null, signal } = {}) {
      if (prefix !== PREFIX || continuationToken !== null && !token(continuationToken)) fail('cloud-backup-invalid');
      return operation(signal, async bounded => {
        const response = await send(new sdk.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: PAGE_SIZE,
          ...(continuationToken === null ? {} : { ContinuationToken: continuationToken }) }), bounded);
        if (!object(response) || response.IsTruncated !== undefined && typeof response.IsTruncated !== 'boolean'
          || response.Contents !== undefined && !Array.isArray(response.Contents)
          || (response.Contents?.length || 0) > PAGE_SIZE || response.Name !== undefined && response.Name !== bucket
          || response.Prefix !== undefined && response.Prefix !== prefix) fail('cloud-backup-invalid-response');
        const items = [], seen = new Set();
        for (const entry of response.Contents || []) {
          if (!object(entry) || typeof entry.Key !== 'string' || !KEY.test(entry.Key) || seen.has(entry.Key)
            || !Number.isSafeInteger(entry.Size) || entry.Size < 2 || entry.Size > MAX_BYTES) fail('cloud-backup-invalid-response');
          seen.add(entry.Key);
          if (entry.LastModified !== undefined && (!(entry.LastModified instanceof Date) || !Number.isFinite(entry.LastModified.getTime()))) fail('cloud-backup-invalid-response');
          items.push({ key: entry.Key, size: entry.Size,
            ...(entry.LastModified === undefined ? {} : { lastModified: entry.LastModified.toISOString() }) });
        }
        const next = response.IsTruncated ? response.NextContinuationToken : null;
        if (response.IsTruncated && (!token(next) || next === continuationToken)
          || !response.IsTruncated && response.NextContinuationToken !== undefined) fail('cloud-backup-invalid-response');
        return { items, continuationToken: next };
      });
    },
    close() { if (owned && typeof client.destroy === 'function') client.destroy(); }
  };
}

module.exports = { createS3BackupTransport };
