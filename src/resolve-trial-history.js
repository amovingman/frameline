'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { readRenameTrialResult } = require('./resolve-rename-trial');
const { createResolveRevisionManifest } = require('./resolve-revision-manifest');

async function inspectRenameTrialHistoryLink({ directory, store, result, snapshot, target } = {}) {
  let link;
  try {
    const handle = await fs.open(path.join(directory, 'revision-link.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw new Error('invalid-trial-revision-link');
      link = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const manifest = createResolveRevisionManifest(snapshot);
  const project = (await store.listResolveProjects()).find(value => value.editorProjectId === snapshot.project_id);
  if (!project || link.schemaVersion !== 1 || link.projectId !== project.id || link.transactionId !== result.transactionId
    || link.status !== result.status || link.validation !== 'observed-fields-only' || link.contentHash !== manifest.sourceHash
    || link.resultingSnapshotSha256 !== result.resultingSnapshotSha256 || link.auditHash !== (result.review?.auditHash || null)
    || link.branch !== target.branch || link.expectedHeadId !== target.expectedHeadId) throw new Error('trial-history-link-mismatch');
  const revision = await store.getRevision(project.id, link.revisionId);
  if (revision.parentRevisionId !== target.expectedHeadId || revision.contentHash !== manifest.sourceHash
    || revision.message !== `Rename trial ${result.transactionId} ${result.status}`) throw new Error('trial-history-link-mismatch');
  return link;
}

// The immutable transaction directory retains the full review/audit record and
// backup. History receives an ordinary observation revision and a durable link.
// These are observed fields, never a lossless project revision.
async function saveRenameTrialRevision({ directory, store, branch, expectedHeadId } = {}) {
  const { result, snapshot } = await readRenameTrialResult(directory);
  if (result.status === 'recovery-required') throw new Error('trial-recovery-required');
  if (expectedHeadId === undefined || typeof branch !== 'string' || !branch) throw new Error('trial-history-target-required');
  const project = await store.getResolveProjectId(snapshot.project_id, snapshot.project_name);
  const manifest = createResolveRevisionManifest(snapshot);
  const message = `Rename trial ${result.transactionId} ${result.status}`;
  const linkPath = path.join(directory, 'revision-link.json');
  let existing = null;
  try {
    const handle = await fs.open(linkPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > 8192) throw new Error('invalid-trial-revision-link');
      existing = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  async function verify(revisionId) {
    const revision = await store.getRevision(project.id, revisionId);
    if (revision.parentRevisionId !== expectedHeadId || revision.contentHash !== manifest.sourceHash
      || revision.message !== message) throw new Error('trial-history-link-mismatch');
    return revision;
  }
  if (existing) {
    if (existing.schemaVersion !== 1 || existing.status !== result.status || existing.validation !== 'observed-fields-only'
      || existing.contentHash !== manifest.sourceHash || existing.transactionId !== result.transactionId || existing.branch !== branch
      || existing.projectId !== project.id || existing.expectedHeadId !== expectedHeadId
      || existing.resultingSnapshotSha256 !== result.resultingSnapshotSha256
      || existing.auditHash !== (result.review?.auditHash || null)) throw new Error('trial-history-link-mismatch');
    await verify(existing.revisionId);
    return existing;
  }
  const state = await store.getBranchState(project.id);
  if (state.currentBranch !== branch) throw new Error('trial-history-branch-changed');
  const revisions = await store.listRevisions(project.id, branch);
  // Reconcile a crash after the revision was saved but before its link was
  // persisted. The transaction ID gives this exact operation a unique message.
  const candidates = revisions.filter(revision => revision.message === message);
  if (candidates.length > 1) throw new Error('trial-history-ambiguous');
  const revision = candidates.length ? await verify(candidates[0].id)
    : await store.saveRevision(project.id, manifest, message, expectedHeadId, branch);
  const link = { schemaVersion: 1, transactionId: result.transactionId, projectId: project.id,
    branch, expectedHeadId, revisionId: revision.id, contentHash: manifest.sourceHash,
    resultingSnapshotSha256: result.resultingSnapshotSha256, auditHash: result.review?.auditHash || null,
    status: result.status, validation: 'observed-fields-only' };
  try {
    const handle = await fs.open(linkPath, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(link)}\n`); await handle.sync(); } finally { await handle.close(); }
    const parent = await fs.open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return saveRenameTrialRevision({ directory, store, branch, expectedHeadId });
  }
  return link;
}

module.exports = { saveRenameTrialRevision, inspectRenameTrialHistoryLink };
