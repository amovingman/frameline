'use strict';

// Internal Console experiment, also used by the opt-in desktop rollback drill.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomBytes } = require('node:crypto');
const { normalizeResolveSnapshot } = require('./resolve-snapshot-normalizer');
const { compareResolveManifests } = require('./resolve-id-diff');
const { inspectResolveProjectExport } = require('./resolve-project-export');
const { resolveReviewedRename } = require('./resolve-rename-review');
const { parseEffectObservation } = require('./resolve-effect-observation');

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

function effectStates(plan) {
  if (!plan.effectGuard) return { before: plan.before, after: plan.after };
  if (Object.keys(plan.effectGuard).sort().join(',') !== 'sourceBase64,sourceSha256'
    || typeof plan.effectGuard.sourceBase64 !== 'string' || plan.effectGuard.sourceBase64.length > 28 * 1024 * 1024) {
    throw new Error('invalid-effect-source');
  }
  const bytes = Buffer.from(plan.effectGuard.sourceBase64, 'base64');
  if (bytes.toString('base64') !== plan.effectGuard.sourceBase64 || sha(bytes) !== plan.effectGuard.sourceSha256) throw new Error('effect-source-hash-mismatch');
  const before = parseEffectObservation(bytes);
  if (json(before.snapshot) !== json(plan.before)) throw new Error('effect-source-snapshot-mismatch');
  const after = structuredClone(before);
  after.snapshot = structuredClone(plan.after);
  return { before, after };
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
    effectStates(plan);
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

async function capturePrelude(withEffects = false) {
  const source = await fs.readFile(path.join(__dirname, 'companion', 'resolve-internal.lua'), 'utf8');
  const sentinel = 'return { capture_request = capture_request }';
  if (!source.includes(sentinel)) throw new Error('capture-source-incompatible');
  const line = value => value.split('\n').filter(row => !/^\s*--/.test(row)).join(' ');
  const base = `local c=(function() ${line(source.replace(sentinel, 'return { capture=capture, encode=encode, array=array }'))} end)(); `;
  if (!withEffects) return base + 'local function capture_state() return c.capture(resolve) end;local function encode_state(value) return c.encode(value) end;';
  const effects = await fs.readFile(path.join(__dirname, 'companion', 'resolve-effects.lua'), 'utf8');
  return base + `local effects=(function() ${line(effects)} end)();local function capture_state() return effects.capture(resolve,c) end;local function encode_state(value) return effects.encode(value) end;`;
}

async function prepareTrial({ beforeBytes, afterBytes, destinationDir, disposableProjectName, effectObservationBytes } = {}, reviewContext = null) {
  const before = parse(beforeBytes), incoming = parse(afterBytes);
  const change = renameChange(before, incoming);
  const after = structuredClone(before);
  after.timelines.find(timeline => timeline.id === change.timelineId).items
    .find(item => item.id === change.itemId).name = change.after;
  if (typeof disposableProjectName !== 'string' || !disposableProjectName.startsWith('Frameline ')
    || before.project_name !== disposableProjectName) throw new Error('named-disposable-project-required');
  if (effectObservationBytes !== undefined) parseEffectObservation(effectObservationBytes);
  const effectGuard = effectObservationBytes === undefined ? null : {
    sourceBase64: Buffer.from(effectObservationBytes).toString('base64'), sourceSha256: sha(effectObservationBytes) };
  // Validate the supplement and its exact represented snapshot before reserving
  // any transaction directory. Only the clip name may change in the result.
  effectStates({ before, after, effectGuard });
  const root = await privateDirectory(destinationDir);
  const id = randomBytes(16).toString('hex');
  const directory = path.join(root, `rename-${Date.now()}-${id}`);
  await fs.mkdir(directory, { mode: 0o700 });
  const plan = { schemaVersion: 1, experimental: true, id, createdAt: new Date().toISOString(),
    sourceSha256: sha(beforeBytes), incomingSha256: sha(afterBytes), before, after, change,
    backupPath: path.join(directory, 'before.drp'), ...(reviewContext ? { reviewContext } : {}), ...(effectGuard ? { effectGuard } : {}) };
  if (Buffer.byteLength(json(plan)) > 45 * 1024 * 1024) throw new Error('trial-record-too-large');
  await writeRecord(directory, 'prepared.json', plan);
  const states = effectStates(plan);
  const command = await capturePrelude(Boolean(plan.effectGuard)) + `assert(encode_state(capture_state())==${quote(json(states.before))},'Stale source'); local pm=resolve:GetProjectManager(); assert(bmd and bmd.fileexists and not bmd.fileexists(${quote(plan.backupPath)}),'Backup destination unavailable'); assert(pm:SaveProject(),'Save failed'); assert(pm:ExportProject(${quote(before.project_name)},${quote(plan.backupPath)},false),'Backup export failed'); assert(encode_state(capture_state())==${quote(json(states.before))},'Source changed during backup'); print('FRAMELINE_RENAME_BACKUP_V1:${id}')`;
  return { directory, command, transactionId: id, backupPath: plan.backupPath, experimental: true };
}

async function prepareRenameTrial(options) { return prepareTrial(options); }

async function prepareReviewedRenameTrial({ sources, plan, audit, destinationDir, disposableProjectName, effectObservationBytes } = {}) {
  const derived = resolveReviewedRename({ sources, plan, audit });
  const reviewContext = { sources: Object.fromEntries(['base', 'local', 'incoming']
    .map(role => [role, Buffer.from(sources[role]).toString('base64')])), preview: plan, audit };
  return prepareTrial({ beforeBytes: derived.beforeBytes, afterBytes: derived.afterBytes,
    destinationDir, disposableProjectName, effectObservationBytes }, reviewContext);
}

async function issueRenameTrial({ directory, forceFailure = false } = {}) {
  if (typeof forceFailure !== 'boolean') throw new Error('invalid-trial-option');
  const plan = await readPlan(directory);
  const states = effectStates(plan);
  // Resolve creates mode 0666 exports. The containing directory is private;
  // narrow the regular file through its descriptor before archive inspection.
  const handle = await fs.open(plan.backupPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { if (!(await handle.stat()).isFile()) throw new Error('invalid-backup'); await handle.chmod(0o600); }
  finally { await handle.close(); }
  const backup = await inspectResolveProjectExport(plan.backupPath);
  await writeRecord(directory, 'issued.json', { transactionId: plan.id, backup, forceFailure, issuedAt: new Date().toISOString() });
  const command = await capturePrelude(Boolean(plan.effectGuard)) + `local pm=resolve:GetProjectManager(); local before=${quote(json(states.before))}; local after=${quote(json(states.after))}; assert(encode_state(capture_state())==before,'Stale source'); assert(bmd and bmd.fileexists and bmd.fileexists(${quote(plan.backupPath)}),'Backup missing'); FRAMELINE_RENAME_TRIAL_USED=FRAMELINE_RENAME_TRIAL_USED or {}; assert(not FRAMELINE_RENAME_TRIAL_USED[${quote(plan.id)}],'Trial already consumed'); local function target() local p=pm:GetCurrentProject(); assert(p:GetUniqueId()==${quote(plan.before.project_id)},'Project changed'); for n=1,p:GetTimelineCount() do local t=p:GetTimelineByIndex(n); if t:GetUniqueId()==${quote(plan.change.timelineId)} then for _,kind in ipairs({'video','audio','subtitle'}) do for track=1,t:GetTrackCount(kind) do for _,item in ipairs(t:GetItemListInTrack(kind,track) or {}) do if item:GetUniqueId()==${quote(plan.change.itemId)} then return item end end end end end end; error('Target missing') end; local function reopen() assert(pm:SaveProject(),'Save failed'); assert(pm:CloseProject(pm:GetCurrentProject()),'Close failed'); assert(pm:LoadProject(${quote(plan.before.project_name)}),'Reopen failed') end; FRAMELINE_RENAME_TRIAL_USED[${quote(plan.id)}]=true; local ok,err=pcall(function() assert(target():SetName(${quote(plan.change.after)}),'Rename failed'); reopen(); assert(encode_state(capture_state())==after,'Applied state differs'); ${forceFailure ? "error('Intentional trial failure');" : ''} end); local status='applied'; if not ok then local recovered=pcall(function() assert(target():GetName()==${quote(plan.change.after)} or target():GetName()==${quote(plan.change.before)},'Unexpected recovery state'); assert(target():SetName(${quote(plan.change.before)}),'Rollback failed'); reopen(); assert(encode_state(capture_state())==before,'Rollback state differs') end); status=recovered and 'rolled-back' or 'recovery-required' end; local s=encode_state(capture_state()); assert(#s<=20*1024*1024,'Trial capture too large'); local n,index=1,1; while n<=#s do local last=math.min(n+8191,#s); while last<#s and s:byte(last+1)>=128 and s:byte(last+1)<=191 do last=last-1 end; assert(last>=n,'Invalid UTF-8 boundary'); print('FRAMELINE_RENAME_TRIAL_CAPTURE_V1:${plan.id}:'..index..':'..s:sub(n,last)); n=last+1; index=index+1 end; print('FRAMELINE_RENAME_TRIAL_RESULT_V1:${plan.id}:'..status)`;
  return { transactionId: plan.id, command, backup, backupPath: plan.backupPath, experimental: true };
}

function checkResultEffects(plan, status, snapshot, effectObservationBytes) {
  if (!plan.effectGuard) {
    if (effectObservationBytes !== undefined) throw new Error('unexpected-effect-result');
    return;
  }
  if (effectObservationBytes === undefined) throw new Error('missing-effect-result');
  const observation = parseEffectObservation(effectObservationBytes);
  const states = effectStates(plan);
  if (json(observation.snapshot) !== json(snapshot)
    || (status !== 'recovery-required' && json(observation) !== json(status === 'applied' ? states.after : states.before))) {
    throw new Error('trial-effect-result-mismatch');
  }
}

// An interrupted record can be retried only with the same exact artifact bytes.
async function writeResultBytes(directory, name, bytes) {
  const filename = path.join(directory, name);
  try {
    const handle = await fs.open(filename, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.mode & 0o077 || stat.size !== Buffer.byteLength(bytes)
        || !(await handle.readFile()).equals(Buffer.from(bytes))) throw error;
    } finally { await handle.close(); }
  }
}

async function recordRenameTrialResult({ directory, status, snapshotBytes, effectObservationBytes } = {}) {
  const plan = await readPlan(directory);
  if (!['applied', 'rolled-back', 'recovery-required'].includes(status)) throw new Error('invalid-trial-status');
  const snapshot = parse(snapshotBytes);
  if (status !== 'recovery-required' && json(snapshot) !== json(status === 'applied' ? plan.after : plan.before)) throw new Error('trial-result-mismatch');
  checkResultEffects(plan, status, snapshot, effectObservationBytes);
  const issued = JSON.parse(await fs.readFile(path.join(directory, 'issued.json'), 'utf8'));
  if (issued.transactionId !== plan.id || typeof issued.backup?.sha256 !== 'string') throw new Error('invalid-issued-trial');
  const backup = await inspectResolveProjectExport(plan.backupPath, issued.backup.sha256);
  const result = { schemaVersion: 1, experimental: true, transactionId: plan.id, status,
    sourceSha256: plan.sourceSha256, incomingSha256: plan.incomingSha256,
    resultingSnapshotSha256: sha(snapshotBytes), backup, backupPath: plan.backupPath,
    validation: 'observed-fields-only', recordedAt: new Date().toISOString(),
    ...(plan.effectGuard ? { effectObservation: { sourceSha256: plan.effectGuard.sourceSha256,
      resultingSha256: sha(effectObservationBytes), validation: 'observed-effect-metadata-only' } } : {}),
    ...(plan.reviewContext ? { review: { sourceBindings: plan.reviewContext.preview.binding,
      planHash: plan.reviewContext.audit.planHash, auditHash: plan.reviewContext.audit.auditHash,
      choices: plan.reviewContext.audit.choices } } : {}) };
  await writeResultBytes(directory, 'result-snapshot.json', snapshotBytes);
  if (plan.effectGuard) await writeResultBytes(directory, 'result-effects.json', effectObservationBytes);
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
  let effectObservationBytes;
  if (plan.effectGuard) {
    effectObservationBytes = await privateBytes('result-effects.json', 20 * 1024 * 1024);
    const expected = { sourceSha256: plan.effectGuard.sourceSha256,
      resultingSha256: sha(effectObservationBytes), validation: 'observed-effect-metadata-only' };
    if (json(result.effectObservation) !== json(expected)) throw new Error('trial-effect-result-mismatch');
  } else if (result.effectObservation !== undefined) throw new Error('unexpected-effect-result');
  checkResultEffects(plan, result.status, snapshot, effectObservationBytes);
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
  if (!chunks.length || chunks.length > 2561) throw new Error('invalid-trial-capture-parts');
  let bytes = '';
  for (const [index, chunk] of chunks.entries()) {
    const match = /^(\d+):(.*)$/.exec(chunk.line.slice(prefix.length));
    if (!match || Number(match[1]) !== index + 1 || !match[2] || chunk.index >= resultIndex
      || Buffer.byteLength(match[2]) > 8192) throw new Error('invalid-trial-capture-parts');
    bytes += match[2];
  }
  const effectObservationBytes = plan.effectGuard ? `${bytes}\n` : undefined;
  const snapshotBytes = plan.effectGuard ? `${json(parseEffectObservation(effectObservationBytes).snapshot)}\n` : `${bytes}\n`;
  return recordRenameTrialResult({ directory, status: resultLines[0].slice(statusPrefix.length), snapshotBytes, effectObservationBytes });
}

module.exports = { prepareRenameTrial, prepareReviewedRenameTrial, issueRenameTrial, recordRenameTrialResult, recordRenameTrialConsoleResult, readRenameTrialResult };
