'use strict';

// Internal Console experiment. No renderer/IPC entry point is registered.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');
const { inspectResolveProjectExport } = require('./resolve-project-export');
const { resolveReviewedRename } = require('./resolve-rename-review');

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const json = value => JSON.stringify(canonical(value));
const quote = value => JSON.stringify(value);

function parse(bytes) {
  if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > 20 * 1024 * 1024) throw new Error('invalid-trial-source');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  normalizeResolveSnapshot(snapshot);
  return snapshot;
}

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory || '')) throw new Error('invalid-trial-directory');
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('trial-symlink');
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.mode & 0o077) throw new Error('trial-directory-not-private');
  return absolute;
}

async function writeRecord(directory, name, value) {
  const handle = await fs.open(path.join(directory, name), 'wx', 0o600);
  try { await handle.writeFile(`${json(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const root = await fs.open(directory, constants.O_RDONLY);
  try { await root.sync(); } finally { await root.close(); }
}

async function readPlan(directory) {
  await privateDirectory(directory);
  const handle = await fs.open(path.join(directory, 'prepared.json'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.mode & 0o077 || stat.size > 45 * 1024 * 1024) throw new Error('invalid-trial-record');
    const plan = JSON.parse(await handle.readFile('utf8'));
    if (!/^[a-f0-9]{32}$/.test(plan.id || '') || plan.backupPath !== path.join(directory, 'before.drp')) throw new Error('invalid-trial-record');
    const verified = renameChange(plan.before, plan.after);
    if (json(verified) !== json(plan.change)) throw new Error('invalid-trial-record');
    if (plan.reviewContext) {
      const { sources, preview, audit } = plan.reviewContext;
      const restoredSources = Object.fromEntries(['base', 'local', 'incoming'].map(role => [role, Buffer.from(sources[role], 'base64')]));
      const reviewed = resolveReviewedRename({ sources: restoredSources, plan: preview, audit });
      if (json(parse(reviewed.beforeBytes)) !== json(plan.before) || json(parse(reviewed.afterBytes)) !== json(plan.after)
        || plan.sourceSha256 !== sha(reviewed.beforeBytes) || plan.incomingSha256 !== sha(reviewed.afterBytes)) {
        throw new Error('trial-review-binding-mismatch');
      }
    }
    return plan;
  } finally { await handle.close(); }
}

function renameChange(before, after) {
  if (before.project_name !== after.project_name) throw new Error('project-name-changed');
  const diff = compareResolveManifests(normalizeResolveSnapshot(before), normalizeResolveSnapshot(after));
  if (diff.changes.length !== 1 || diff.changes[0].kind !== 'item-changed' || diff.changes[0].field !== 'name'
    || !diff.changes[0].after.trim()) throw new Error('trial-requires-one-rename');
  return diff.changes[0];
}

async function capturePrelude() {
  const source = await fs.readFile(path.join(__dirname, 'companion', 'resolve-internal.lua'), 'utf8');
  const sentinel = 'return { capture_request = capture_request }';
  if (!source.includes(sentinel)) throw new Error('capture-source-incompatible');
  return `local c=(function() ${source.replace(sentinel, 'return { capture=capture, encode=encode }').split('\n').filter(line => !/^\s*--/.test(line)).join(' ')} end)(); `;
}

async function prepareTrial({ beforeBytes, afterBytes, destinationDir, disposableProjectName } = {}, reviewContext = null) {
  const before = parse(beforeBytes), incoming = parse(afterBytes);
  const change = renameChange(before, incoming);
  const after = structuredClone(before);
  after.timelines.find(timeline => timeline.id === change.timelineId).items
    .find(item => item.id === change.itemId).name = change.after;
  if (typeof disposableProjectName !== 'string' || !disposableProjectName.startsWith('Frameline ')
    || before.project_name !== disposableProjectName) throw new Error('named-disposable-project-required');
  const root = await privateDirectory(destinationDir);
  const id = randomBytes(16).toString('hex');
  const directory = path.join(root, `rename-${Date.now()}-${id}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const plan = { schemaVersion: 1, experimental: true, id, createdAt: new Date().toISOString(),
    sourceSha256: sha(beforeBytes), incomingSha256: sha(afterBytes), before, after, change,
    backupPath: path.join(directory, 'before.drp'), ...(reviewContext ? { reviewContext } : {}) };
  if (Buffer.byteLength(json(plan)) > 45 * 1024 * 1024) throw new Error('trial-record-too-large');
  await writeRecord(directory, 'prepared.json', plan);
  const command = await capturePrelude() + `assert(c.encode(c.capture(resolve))==${quote(json(before))},'Stale source'); local pm=resolve:GetProjectManager(); assert(bmd and bmd.fileexists and not bmd.fileexists(${quote(plan.backupPath)}),'Backup destination unavailable'); assert(pm:SaveProject(),'Save failed'); assert(pm:ExportProject(${quote(before.project_name)},${quote(plan.backupPath)},false),'Backup export failed'); assert(c.encode(c.capture(resolve))==${quote(json(before))},'Source changed during backup'); print('FRAMELINE_RENAME_BACKUP_V1:${id}')`;
  return { directory, command, transactionId: id, backupPath: plan.backupPath, experimental: true };
}

async function prepareRenameTrial(options) { return prepareTrial(options); }

async function prepareReviewedRenameTrial({ sources, plan, audit, destinationDir, disposableProjectName } = {}) {
  const derived = resolveReviewedRename({ sources, plan, audit });
  const reviewContext = { sources: Object.fromEntries(['base', 'local', 'incoming']
    .map(role => [role, Buffer.from(sources[role]).toString('base64')])), preview: plan, audit };
  return prepareTrial({ beforeBytes: derived.beforeBytes, afterBytes: derived.afterBytes,
    destinationDir, disposableProjectName }, reviewContext);
}

async function issueRenameTrial({ directory, forceFailure = false } = {}) {
  if (typeof forceFailure !== 'boolean') throw new Error('invalid-trial-option');
  const plan = await readPlan(directory);
  // Resolve creates mode 0666 exports. The containing directory is private;
  // narrow the regular file through its descriptor before archive inspection.
  const handle = await fs.open(plan.backupPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { if (!(await handle.stat()).isFile()) throw new Error('invalid-backup'); await handle.chmod(0o600); }
  finally { await handle.close(); }
  const backup = await inspectResolveProjectExport(plan.backupPath);
  await writeRecord(directory, 'issued.json', { transactionId: plan.id, backup, forceFailure, issuedAt: new Date().toISOString() });
  const command = await capturePrelude() + `local pm=resolve:GetProjectManager(); local before=${quote(json(plan.before))}; local after=${quote(json(plan.after))}; assert(c.encode(c.capture(resolve))==before,'Stale source'); assert(bmd and bmd.fileexists and bmd.fileexists(${quote(plan.backupPath)}),'Backup missing'); FRAMELINE_RENAME_TRIAL_USED=FRAMELINE_RENAME_TRIAL_USED or {}; assert(not FRAMELINE_RENAME_TRIAL_USED[${quote(plan.id)}],'Trial already consumed'); local function target() local p=pm:GetCurrentProject(); assert(p:GetUniqueId()==${quote(plan.before.project_id)},'Project changed'); for n=1,p:GetTimelineCount() do local t=p:GetTimelineByIndex(n); if t:GetUniqueId()==${quote(plan.change.timelineId)} then for _,kind in ipairs({'video','audio','subtitle'}) do for track=1,t:GetTrackCount(kind) do for _,item in ipairs(t:GetItemListInTrack(kind,track) or {}) do if item:GetUniqueId()==${quote(plan.change.itemId)} then return item end end end end end end; error('Target missing') end; local function reopen() assert(pm:SaveProject(),'Save failed'); assert(pm:CloseProject(pm:GetCurrentProject()),'Close failed'); assert(pm:LoadProject(${quote(plan.before.project_name)}),'Reopen failed') end; FRAMELINE_RENAME_TRIAL_USED[${quote(plan.id)}]=true; local ok,err=pcall(function() assert(target():SetName(${quote(plan.change.after)}),'Rename failed'); reopen(); assert(c.encode(c.capture(resolve))==after,'Applied state differs'); ${forceFailure ? "error('Intentional trial failure');" : ''} end); local status='applied'; if not ok then local recovered=pcall(function() assert(target():GetName()==${quote(plan.change.after)} or target():GetName()==${quote(plan.change.before)},'Unexpected recovery state'); assert(target():SetName(${quote(plan.change.before)}),'Rollback failed'); reopen(); assert(c.encode(c.capture(resolve))==before,'Rollback state differs') end); status=recovered and 'rolled-back' or 'recovery-required' end; local s=c.encode(c.capture(resolve)); for n=1,#s,8192 do print('FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${plan.id}:'..math.floor((n-1)/8192+1)..':'..s:sub(n,n+8191)) end; print('FRAMELINE_RENAME_TRIAL_RESULT_V1:${plan.id}:'..status)`;
  return { transactionId: plan.id, command, backup, backupPath: plan.backupPath, experimental: true };
}

async function recordRenameTrialResult({ directory, status, snapshotBytes } = {}) {
  const plan = await readPlan(directory);
  if (!['applied', 'rolled-back', 'recovery-required'].includes(status)) throw new Error('invalid-trial-status');
  const snapshot = parse(snapshotBytes);
  if (status !== 'recovery-required' && json(snapshot) !== json(status === 'applied' ? plan.after : plan.before)) throw new Error('trial-result-mismatch');
  const issued = JSON.parse(await fs.readFile(path.join(directory, 'issued.json'), 'utf8'));
  if (issued.transactionId !== plan.id || typeof issued.backup?.sha256 !== 'string') throw new Error('invalid-issued-trial');
  const backup = await inspectResolveProjectExport(plan.backupPath, issued.backup.sha256);
  const result = { schemaVersion: 1, experimental: true, transactionId: plan.id, status,
    sourceSha256: plan.sourceSha256, incomingSha256: plan.incomingSha256,
    resultingSnapshotSha256: sha(snapshotBytes), backup, backupPath: plan.backupPath,
    validation: 'observed-fields-only', recordedAt: new Date().toISOString(),
    ...(plan.reviewContext ? { review: { sourceBindings: plan.reviewContext.preview.binding,
      planHash: plan.reviewContext.audit.planHash, auditHash: plan.reviewContext.audit.auditHash,
      choices: plan.reviewContext.audit.choices } } : {}) };
  const snapshotPath = path.join(directory, 'result-snapshot.json');
  try {
    const handle = await fs.open(snapshotPath, 'wx', 0o600);
    try { await handle.writeFile(snapshotBytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const handle = await fs.open(snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size !== Buffer.byteLength(snapshotBytes)
        || !(await handle.readFile()).equals(Buffer.from(snapshotBytes))) throw error;
    } finally { await handle.close(); }
  }
  await writeRecord(directory, 'result.json', result);
  return result;
}

async function readRenameTrialResult(directory) {
  const plan = await readPlan(directory);
  async function privateBytes(name, limit) {
    const handle = await fs.open(path.join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size > limit) throw new Error('invalid-trial-result-file');
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size) throw new Error('trial-result-file-changed');
      return bytes;
    } finally { await handle.close(); }
  }
  const result = JSON.parse(await privateBytes('result.json', 20 * 1024 * 1024));
  const snapshotBytes = await privateBytes('result-snapshot.json', 20 * 1024 * 1024);
  const snapshot = parse(snapshotBytes);
  if (result.transactionId !== plan.id || result.sourceSha256 !== plan.sourceSha256
    || result.incomingSha256 !== plan.incomingSha256 || result.resultingSnapshotSha256 !== sha(snapshotBytes)
    || !['applied', 'rolled-back', 'recovery-required'].includes(result.status)) throw new Error('trial-result-mismatch');
  if (result.status !== 'recovery-required' && json(snapshot) !== json(result.status === 'applied' ? plan.after : plan.before)) throw new Error('trial-result-mismatch');
  const expectedReview = plan.reviewContext ? { sourceBindings: plan.reviewContext.preview.binding,
    planHash: plan.reviewContext.audit.planHash, auditHash: plan.reviewContext.audit.auditHash,
    choices: plan.reviewContext.audit.choices } : null;
  if (json(result.review || null) !== json(expectedReview)) throw new Error('trial-review-binding-mismatch');
  if (result.backupPath !== plan.backupPath) throw new Error('invalid-trial-backup-path');
  await inspectResolveProjectExport(plan.backupPath, result.backup.sha256);
  return { result, snapshot };
}

async function recordRenameTrialConsoleResult({ directory, consoleOutput } = {}) {
  if (typeof consoleOutput !== 'string' || Buffer.byteLength(consoleOutput) > 24 * 1024 * 1024) throw new Error('invalid-trial-console-output');
  const plan = await readPlan(directory);
  const lines = consoleOutput.split(/\r?\n/);
  const statusPrefix = `FRAMELINE_RENAME_TRIAL_RESULT_V1:${plan.id}:`;
  const resultLines = lines.filter(line => line.startsWith(statusPrefix));
  if (resultLines.length !== 1) throw new Error('missing-or-duplicate-trial-result');
  const resultIndex = lines.indexOf(resultLines[0]);
  const prefix = `FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${plan.id}:`;
  const chunks = lines.map((line, index) => ({ line, index })).filter(({ line }) => line.startsWith(prefix));
  if (!chunks.length || chunks.length > 2560) throw new Error('invalid-trial-capture-parts');
  let bytes = '';
  for (const [index, chunk] of chunks.entries()) {
    const match = /^(\d+):(.*)$/.exec(chunk.line.slice(prefix.length));
    if (!match || Number(match[1]) !== index + 1 || !match[2] || chunk.index >= resultIndex
      || Buffer.byteLength(match[2]) > 8192) throw new Error('invalid-trial-capture-parts');
    bytes += match[2];
  }
  return recordRenameTrialResult({ directory, status: resultLines[0].slice(statusPrefix.length), snapshotBytes: `${bytes}\n` });
}

module.exports = { prepareRenameTrial, prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, recordRenameTrialConsoleResult, readRenameTrialResult };
