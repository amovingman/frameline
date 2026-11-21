#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createFcpXmlScanner } = require('../src/fcpxml-adapter');
const { createLocalMetadataStore } = require('../src/local-metadata');
const { compareScanRevisions } = require('../src/revision-comparison');

const fixtureDirectory = path.join(__dirname, '..', 'phase-0', 'compatibility-corpus');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// This composes the same scanner, revision store and comparison used by the app.
// All writes are confined to a new temporary directory created by this function.
async function runPortfolioDemo({ keepWorkspace = false } = {}) {
  const fixtureNames = ['edit-before.fcpxml', 'edit-after.fcpxml'];
  const fixtureBytes = await Promise.all(fixtureNames.map(name => fs.readFile(path.join(fixtureDirectory, name))));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-portfolio-'));
  const scanner = createFcpXmlScanner();
  let completed = false;
  try {
    const selectedPath = path.join(directory, 'timeline.fcpxml');
    const historyDirectory = path.join(directory, 'history');
    await Promise.all(fixtureNames.map((name, index) => fs.writeFile(path.join(directory, name), fixtureBytes[index], { flag: 'wx', mode: 0o600 })));
    await fs.writeFile(selectedPath, fixtureBytes[0], { flag: 'wx', mode: 0o600 });
    const store = createLocalMetadataStore(historyDirectory);
    const project = await store.getProjectId(selectedPath);
    const before = await scanner.scan(selectedPath);
    await scanner.verifySource(selectedPath, before.sourceHash);
    const base = await store.saveRevision(project.id, before, 'First cut');

    // Simulate a fresh export at the same selected path, never an editor write.
    await fs.writeFile(selectedPath, fixtureBytes[1]);
    await assert.rejects(scanner.verifySource(selectedPath, before.sourceHash), { code: 'revision-source-changed' });
    const after = await scanner.scan(selectedPath);
    await scanner.verifySource(selectedPath, after.sourceHash);
    const edited = await store.saveRevision(project.id, after, 'Shorter cut', base.id);
    await assert.rejects(store.saveRevision(project.id, after, 'Stale save', base.id), { code: 'revision-head-changed' });

    const reopened = createLocalMetadataStore(historyDirectory);
    const revisions = await reopened.listRevisions(project.id);
    assert.deepEqual(revisions.map(item => item.id), [edited.id, base.id]);
    const savedBase = await reopened.getRevision(project.id, base.id);
    const savedEdit = await reopened.getRevision(project.id, edited.id);
    assert.deepEqual(savedBase.manifest, before);
    assert.deepEqual(savedEdit.manifest, after);
    assert.equal(savedEdit.parentRevisionId, base.id);
    const comparison = compareScanRevisions(savedBase.manifest, savedEdit.manifest);
    assert.equal(comparison.clipChangesAvailable, false);
    assert.equal(comparison.mediaIdentityAvailable, false);
    for (let index = 0; index < fixtureNames.length; index++) {
      assert.equal(digest(await fs.readFile(path.join(fixtureDirectory, fixtureNames[index]))), digest(fixtureBytes[index]));
    }
    const result = {
      schemaVersion: 1,
      sequence: { before: before.sequence.name, after: after.sequence.name, frameDuration: before.sequence.frameDuration },
      comparison,
      checks: { staleSourceRejected: true, staleHeadRejected: true, historyReopened: true,
        immutableParentPreserved: true, repositoryFixturesUnchanged: true },
      ...(keepWorkspace ? { workspace: directory } : {})
    };
    completed = true;
    return result;
  } finally {
    await scanner.dispose();
    if (!keepWorkspace || !completed) await fs.rm(directory, { recursive: true, force: true });
  }
}

function formatTranscript(result) {
  const lines = [
    'Frameline | local revision demo',
    '',
    '1. Scan a synthetic FCPXML 1.10 export in a background worker.',
    '2. Save "First cut", then save "Shorter cut" as its child.',
    '3. Reopen both saved records and compare their manifests.',
    ''
  ];
  for (const change of result.comparison.changes) {
    lines.push(`   ${change.kind}.${change.name}: ${change.before ?? '(absent)'} -> ${change.after ?? '(absent)'}`);
  }
  lines.push('',
    `   Picture clips: ${result.comparison.beforeClipCount} -> ${result.comparison.afterClipCount}`,
    '   Clip identity: unresolved; no clip pairing or Apply offered.',
    '',
    'PASS  Changed source and stale revision head were rejected.',
    'PASS  Saved parent and child survived reopening the store.',
    'PASS  Repository fixtures are unchanged.',
    result.workspace ? 'Workspace retained for inspection.' : 'Temporary workspace removed.');
  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--keep', '--json'].includes(arg)) || new Set(args).size !== args.length) {
    process.stderr.write('Usage: node scripts/portfolio-demo.cjs [--keep] [--json]\n');
    process.exitCode = 1;
  } else {
    runPortfolioDemo({ keepWorkspace: args.includes('--keep') }).then(result => {
      process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : formatTranscript(result));
      if (result.workspace && !args.includes('--json')) process.stdout.write(`Workspace: ${result.workspace}\n`);
    }).catch(() => {
      process.stderr.write('Portfolio demo failed. Run the fixture tests for more detail.\n');
      process.exitCode = 1;
    });
  }
}

module.exports = { runPortfolioDemo, formatTranscript };
