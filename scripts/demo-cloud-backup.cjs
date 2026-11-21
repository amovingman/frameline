#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runPortfolioDemo } = require('./portfolio-demo.cjs');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { inspectBackup, uploadBackup, listBackups, downloadBackup } = require('../src/cloud-backup');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

// This fixture stands in for the remote object store. It never opens a network
// connection or constructs an AWS client. The production backup core is unchanged.
function createSimulatedTransport() {
  const objects = new Map();
  const calls = { put: 0, get: 0, list: 0 };
  return {
    calls,
    async put({ key, bytes, sha256, signal }) {
      if (signal?.aborted) throw fail('cloud-backup-cancelled');
      calls.put++;
      assert.equal(digest(bytes), sha256);
      if (objects.has(key)) throw fail('cloud-backup-exists');
      objects.set(key, Buffer.from(bytes));
      return { uploaded: true };
    },
    async get({ key, maxBytes, signal }) {
      if (signal?.aborted) throw fail('cloud-backup-cancelled');
      calls.get++;
      const bytes = objects.get(key);
      if (!bytes) throw fail('cloud-backup-not-found');
      if (bytes.length > maxBytes) throw fail('cloud-backup-too-large');
      return Buffer.from(bytes);
    },
    async list({ prefix, continuationToken, signal }) {
      if (signal?.aborted) throw fail('cloud-backup-cancelled');
      calls.list++;
      assert.equal(continuationToken == null, true);
      return { items: [...objects].filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, size: bytes.length })), continuationToken: null };
    }
  };
}

async function runCloudBackupDemo() {
  const fixture = await runPortfolioDemo({ keepWorkspace: true });
  try {
    const directory = await fs.realpath(fixture.workspace);
    const store = createLocalMetadataStore(path.join(directory, 'history'));
    // Project identity follows the originally selected path. Keep that spelling
    // even when macOS's temporary-directory alias resolves to another pathname.
    const project = await store.getProjectId(path.join(fixture.workspace, 'timeline.fcpxml'));
    const bundle = await store.exportRevisionsReadOnly(project.id);
    assert.equal(bundle.records.length, 2);
    const bytes = Buffer.from(`${JSON.stringify(bundle)}\n`);
    const filename = path.join(directory, 'export.json');
    const destination = path.join(directory, 'download.json');
    await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
    const transport = createSimulatedTransport();
    const inspected = await inspectBackup(filename);
    assert.equal(inspected.sha256, digest(bytes));
    const request = { filename, expectedSha256: inspected.sha256, transport };
    const uploaded = await uploadBackup(request);
    assert.equal(uploaded.uploaded, true);
    assert.equal(uploaded.reused, false);
    const retry = await uploadBackup(request);
    assert.equal(retry.reused, true);
    const listed = await listBackups({ transport });
    assert.equal(listed.backups.length, 1);
    assert.equal(listed.backups[0].sha256, inspected.sha256);
    assert.equal(listed.backups[0].byteCount, bytes.length);
    const downloaded = await downloadBackup({ sha256: inspected.sha256, destination, transport });
    assert.equal(downloaded.downloaded, true);
    assert.deepEqual(await fs.readFile(destination), bytes);
    assert.deepEqual(await fs.readFile(filename), bytes);
    const original = await store.exportRevisionsReadOnly(project.id);
    assert.deepEqual(original, bundle);
    assert.equal(transport.calls.put, 2);
    assert.equal(transport.calls.list, 1);
    assert(transport.calls.get >= 2);
    return { schemaVersion: 1, storage: 'simulated-in-memory', liveAwsVerified: false,
      revisionCount: bundle.records.length, byteCount: bytes.length,
      checks: { validBundleInspected: true, uploadStoredExactBytes: true,
        identicalRetryVerified: true, listingCompleted: true,
        downloadPreservedExactBytes: true, sourceAndHistoryUnchanged: true,
        temporaryWorkspaceRemoved: true } };
  } finally {
    await fs.rm(fixture.workspace, { recursive: true, force: true });
  }
}

function formatCloudDemo(result) {
  return [
    'Frameline | revision backup demo',
    'Storage: simulated in memory. No AWS request or credentials.',
    '',
    `PASS  Exported and inspected ${result.revisionCount} real saved revisions.`,
    'PASS  Uploaded the bundle through the production backup core.',
    'PASS  Repeated upload verified the existing identical object.',
    'PASS  Listed the backup and downloaded the exact original bytes.',
    'PASS  Source export and saved history remain unchanged.',
    'PASS  Temporary workspace removed.',
    '',
    'This run does not verify a live S3 bucket.',
    ''
  ].join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--json')) {
    process.stderr.write('Usage: node scripts/demo-cloud-backup.cjs [--json]\n');
    process.exitCode = 1;
  } else runCloudBackupDemo().then(result => {
    process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatCloudDemo(result));
  }).catch(() => {
    process.stderr.write('Cloud backup demo failed. Run the cloud backup tests for details.\n');
    process.exitCode = 1;
  });
}

module.exports = { runCloudBackupDemo, formatCloudDemo };
