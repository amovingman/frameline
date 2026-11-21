'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash } = require('node:crypto');
const { S3Client } = require('@aws-sdk/client-s3');
const { runPortfolioDemo } = require('../scripts/portfolio-demo.cjs');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { createS3BackupTransport } = require('../src/cloud-backup-s3');
const { runCloudBackupCli } = require('../src/cloud-backup-cli');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checksum = bytes => createHash('sha256').update(bytes).digest('base64');

test('real AWS SDK signs verified HTTPS requests through the CLI for upload, retry, list, download and refusal', { timeout: 30000 }, async t => {
  // This is an S3 protocol fixture on loopback, not an AWS account or bucket.
  const fixture = await runPortfolioDemo({ keepWorkspace: true });
  const directory = await fs.realpath(fixture.workspace);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createLocalMetadataStore(path.join(directory, 'history'));
  const project = await store.getProjectId(path.join(fixture.workspace, 'timeline.fcpxml'));
  const bundle = await store.exportRevisionsReadOnly(project.id);
  const bytes = Buffer.from(JSON.stringify(bundle) + '\n');
  const filename = path.join(directory, 'backup.json'), configFile = path.join(directory, 'cloud.json');
  const bucket = 'portfolio-protocol-fixture';
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  await fs.writeFile(configFile, JSON.stringify({ version: 1, provider: 'aws-s3', region: 'us-east-1', bucket }), { mode: 0o600 });
  const tlsDirectory = path.join(__dirname, 'fixtures/network-tls');
  const objects = new Map(), calls = [];
  let deny = false, failure;
  const xmlError = (response, status, code) => {
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(`<Error><Code>${code}</Code><Message>PRIVATE provider diagnostic</Message></Error>`);
  };
  const server = https.createServer({ cert: await fs.readFile(path.join(tlsDirectory, 'server.pem')),
    key: await fs.readFile(path.join(tlsDirectory, 'server-key.pem')) }, async (request, response) => {
    try {
      assert.match(request.headers.authorization || '', /^AWS4-HMAC-SHA256 Credential=FIXTUREACCESS\//);
      assert.equal(request.headers['x-amz-security-token'], 'fixture-session-token');
      const url = new URL(request.url, 'https://localhost');
      calls.push({ method: request.method, path: url.pathname, list: url.searchParams.get('list-type') });
      if (deny) return xmlError(response, 403, 'AccessDenied');
      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        assert.equal(url.searchParams.get('prefix'), 'frameline-backups/v1/');
        assert.equal(url.searchParams.get('max-keys'), '100');
        response.writeHead(200, { 'content-type': 'application/xml' });
        response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>frameline-backups/v1/</Prefix><KeyCount>${objects.size}</KeyCount><MaxKeys>100</MaxKeys><IsTruncated>false</IsTruncated>${[...objects].map(([key, body]) => `<Contents><Key>${key}</Key><LastModified>2026-11-21T00:00:00.000Z</LastModified><Size>${body.length}</Size></Contents>`).join('')}</ListBucketResult>`);
        return;
      }
      const prefix = `/${bucket}/`;
      assert(url.pathname.startsWith(prefix));
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      if (request.method === 'PUT') {
        assert.equal(request.headers['if-none-match'], '*');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        assert(body.length <= 10 * 1024 * 1024);
        assert.equal(request.headers['x-amz-checksum-sha256'], checksum(body));
        assert.equal(request.headers['x-amz-meta-backup-sha256'], digest(body));
        if (objects.has(key)) return xmlError(response, 412, 'PreconditionFailed');
        objects.set(key, body);
        response.writeHead(200, { 'x-amz-checksum-sha256': checksum(body) }); response.end(); return;
      }
      assert.equal(request.method, 'GET');
      assert.equal(request.headers['x-amz-checksum-mode'], 'ENABLED');
      const body = objects.get(key);
      if (!body) return xmlError(response, 404, 'NoSuchKey');
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length,
        'x-amz-checksum-sha256': checksum(body), etag: '"opaque-etag"' }); response.end(body);
    } catch (error) { failure = error; xmlError(response, 500, 'FixtureFailure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const agent = new https.Agent({ ca: await fs.readFile(path.join(tlsDirectory, 'ca.pem')) });
  const client = new S3Client({ region: 'us-east-1', endpoint: `https://127.0.0.1:${server.address().port}`,
    forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: 'FIXTUREACCESS', secretAccessKey: 'fixture-secret-not-a-real-key', sessionToken: 'fixture-session-token' },
    requestHandler: { httpsAgent: agent, connectionTimeout: 1000, requestTimeout: 3000 } });
  t.after(() => { client.destroy(); agent.destroy(); });
  async function cli(action, args = [], withConfig = true) {
    let stdout = '', stderr = '';
    const code = await runCloudBackupCli({ argv: [action, ...(withConfig ? ['--config', configFile] : []), ...args],
      output: { write: value => { stdout += value; } }, errorOutput: { write: value => { stderr += value; } },
      createTransport: config => createS3BackupTransport({ ...config, client }) });
    if (failure) throw failure;
    return { code, stderr, result: stdout ? JSON.parse(stdout) : null };
  }
  const inspected = await cli('inspect', ['--file', filename], false);
  assert.equal(inspected.code, 0); assert.equal(inspected.result.sha256, digest(bytes)); assert.equal(calls.length, 0);
  const uploadArgs = ['--file', filename, '--sha256', inspected.result.sha256];
  const uploaded = await cli('upload', uploadArgs); assert.equal(uploaded.code, 0); assert.equal(uploaded.result.reused, false);
  const retried = await cli('upload', uploadArgs); assert.equal(retried.code, 0); assert.equal(retried.result.reused, true);
  const listed = await cli('list'); assert.equal(listed.code, 0); assert.equal(listed.result.backups[0].sha256, inspected.result.sha256);
  const destination = path.join(directory, 'download.json');
  const downloaded = await cli('download', ['--sha256', inspected.result.sha256, '--destination', destination]);
  assert.equal(downloaded.code, 0); assert.deepEqual(await fs.readFile(destination), bytes);
  assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  const beforeCollision = calls.length;
  assert.equal((await cli('download', ['--sha256', inspected.result.sha256, '--destination', destination])).stderr, 'cloud-backup-exists\n');
  assert.equal(calls.length, beforeCollision); assert.deepEqual(await fs.readFile(destination), bytes);
  deny = true;
  assert.deepEqual(await cli('list'), { code: 1, stderr: 'cloud-backup-auth\n', result: null });
  deny = false;
  const key = `frameline-backups/v1/${inspected.result.sha256}.json`;
  objects.set(key, Buffer.from('corrupt remote object'));
  const badDestination = path.join(directory, 'corrupt-download.json');
  const refused = await cli('download', ['--sha256', inspected.result.sha256, '--destination', badDestination]);
  assert.equal(refused.code, 1); assert.equal(refused.stderr, 'cloud-backup-invalid-response\n');
  await assert.rejects(fs.stat(badDestination), { code: 'ENOENT' });
  assert.deepEqual(await store.exportRevisionsReadOnly(project.id), bundle);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
  assert.equal(calls.length, 7);
});
