'use strict';
// Reads retained owner evidence and creates census files only in a fresh private
// scratch directory. Never opens a canonical editor database or invokes Resolve.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { constants } = require('node:fs');
const { createHash, createHmac } = require('node:crypto');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const ROOT = path.resolve(__dirname, '..');
const CATALOG = 'phase-0/personal-compatibility-corpus.json';
const NAME_RECEIPT = 'phase-0/native-result-live-proof.json';
const MEDIA_RECEIPT = 'phase-0/media-relink-live-proof.json';
const NAME_RUN = '/private/tmp/frameline-native-result-live-20261121';
const contract = require('../src/personal-compatibility');
const { catalog: exportsCatalog, inspectCorpus } = require('../phase-0/integration-corpus');
const native = require('../src/closed-project-native-store');
const { readProjectIdentity } = require('../src/native-project-identity');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (value, code) => { if (!value) throw Error('personal-corpus-' + code); };
const same = (a, b) => assert.deepEqual(a, b);
const SOURCE_FILES = ['src/personal-compatibility.js', 'scripts/audit-personal-compatibility.cjs',
  'src/fcpxml-scan-core.js', 'src/fcpxml-adapter.js', 'src/scan-manifest.js',
  'src/closed-project-native-store.js', 'src/native-project-identity.js',
  'src/native/resolve/resolve-native-sqlite-snapshot.py', 'src/native/resolve/resolve-native-identity.py',
  'src/closed-project-apply-transaction.js', 'src/closed-project-apply-plan.js',
  'src/media-relink-service.js', 'src/media-relink-import.js',
  'src/companion/media-relink-import.lua', 'src/companion/media-relink-private-json.lua'];

function relative(root, name) {
  need(typeof name === 'string' && name.length > 0 && !path.isAbsolute(name)
    && path.normalize(name) === name && !name.split(path.sep).includes('..'), 'relative-path');
  const result = path.resolve(root, name);
  need(result.startsWith(path.resolve(root) + path.sep), 'relative-path');
  return result;
}
function mapped(root, originalRoot, filename) { return relative(root, path.relative(originalRoot, filename)); }
async function read(filename, privateMode = false, max = 128 * 1024 * 1024) {
  need(await fs.realpath(filename) === filename, 'canonical-file');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    need(before.isFile() && before.nlink === 1n && Number(before.uid) === process.getuid()
      && (!privateMode || !(Number(before.mode) & 0o077)) && before.size > 0n && before.size <= BigInt(max), 'file');
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), named = await fs.lstat(filename, { bigint: true });
    need(bytes.length === Number(before.size) && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode']
      .every(key => before[key] === after[key] && before[key] === named[key]), 'file-changed');
    return bytes;
  } finally { await handle.close(); }
}
async function json(filename, privateMode = false) { return JSON.parse(await read(filename, privateMode, 24 * 1024 * 1024)); }
async function signedContext(filename, keyFile) {
  const envelope = await json(filename, true), key = await read(keyFile, true);
  need(key.length === 32 && typeof envelope.body === 'string'
    && envelope.mac === createHmac('sha256', key).update(envelope.body).digest('hex'), 'context-authentication');
  return JSON.parse(envelope.body);
}

async function observePersonalHost() {
  need(process.platform === 'darwin', 'host-platform');
  const command = async (file, args) => {
    const result = await exec(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 });
    need(result.stderr === '', 'host-observation');
    return result.stdout.trim();
  };
  const info = JSON.parse(await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-',
    '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Info.plist']));
  const target = { editor: 'DaVinci Resolve', edition: 'Free', editorVersion: info.CFBundleShortVersionString,
    editorBuild: info.CFBundleVersion, platform: process.platform };
  need(info.CFBundleIdentifier === 'com.blackmagic-design.DaVinciResolve' && info.CFBundleExecutable === 'Resolve', 'host-editor');
  same(target, contract.PERSONAL_COMPATIBILITY_TARGET);
  const host = { osVersion: await command('/usr/bin/sw_vers', ['-productVersion']),
    osBuild: await command('/usr/bin/sw_vers', ['-buildVersion']), architecture: await command('/usr/bin/uname', ['-m']) };
  same(host, contract.PERSONAL_OBSERVED_HOST);
  return { observedAt: new Date().toISOString(), target, host, installedInfoSha256: sha(JSON.stringify(info)),
    readOnly: true, historicalProofHostPatchEstablished: false };
}

function summary(census) {
  need(census.operation === 'native-sqlite-all-cell-census' && census.readOnly === true && census.integrityCheck === 'ok'
    && census.allPersistentTablesCovered === true && census.allSchemaObjectsCovered === true
    && census.excludedApplicationColumns.length === 0 && census.safeToApply === false, 'complete-census');
  return { logicalSha256: census.logicalSha256, schemaSha256: sha(JSON.stringify(census.schemaObjects)),
    counts: census.counts, allPersistentTablesCovered: true, allSchemaObjectsCovered: true, excludedApplicationColumnCount: 0 };
}
async function inspectRetainedNative(filename) {
  const bytes = await read(filename, true), identity = await readProjectIdentity({ sourcePath: filename });
  need(identity.readOnly === true && identity.sourceSha256 === sha(bytes) && identity.bytes === bytes.length, 'native-identity');
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'personal-native-corpus-')));
  try {
    await fs.chmod(scratch, 0o700);
    const project = path.join(scratch, identity.projectName), output = path.join(scratch, 'census');
    await fs.mkdir(project, { mode: 0o700 }); await fs.mkdir(output, { mode: 0o700 });
    const staged = path.join(project, 'Project.db');
    await fs.writeFile(staged, bytes, { mode: 0o600, flag: 'wx' });
    const captured = await native.inspectClosedDatabase({ sourcePath: staged, directory: output,
      projectId: identity.projectId, projectName: identity.projectName });
    need(captured.databaseBytes.equals(bytes) && (await read(filename, true)).equals(bytes), 'native-source-changed');
    const census = JSON.parse(captured.censusBytes);
    return { bytes, identity, census, censusSummary: summary(census) };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

async function nameCase(root, retentionDirectory) {
  const receiptBytes = await read(relative(root, NAME_RECEIPT)), receipt = JSON.parse(receiptBytes);
  require('./audit-native-result-live.cjs').validateNativeResultReceipt(receipt);
  const retained = retentionDirectory || relative(root, receipt.privateRetentionDirectory), live = path.join(retained, 'live');
  const folder = path.join(live, 'legacy-transactions');
  await read(path.join(folder, 'journal.key'), true);
  const never = () => { throw Error('personal-corpus-has-no-execution-authority'); };
  const transaction = require('../src/closed-project-apply-transaction').createClosedProjectApplyTransaction({
    directory: folder, verifyPlan: never, adapter: Object.fromEntries(['inspectSource', 'createBackup', 'createCandidate',
      'verifyPreservation', 'publish', 'verifyEditor'].map(key => [key, never])) });
  const tx = await transaction.inspect(receipt.legacy.transactionId);
  const context = await signedContext(path.join(live, 'legacy-adapter/plans', tx.plan.planId, 'context.json'),
    path.join(live, 'legacy-adapter/context.key'));
  same(context.plan, tx.plan);
  const proof = tx.editorProof, opened = proof?.openEvidence, closed = proof?.closedEvidence;
  need(tx.state === 'rolled-back' && tx.source.sha256 === receipt.legacy.originalSha256
    && tx.backup.sha256 === tx.source.sha256 && proof?.verified === true && proof.closed === true
    && proof.direction === 'rollback' && proof.metadataPreserved === true
    && proof.proofSha256 === receipt.legacy.rollbackEditorProofSha256 && proof.sourceSha256 === tx.source.sha256
    && proof.projectId === tx.plan.projectId && proof.itemId === tx.plan.edit.itemId
    && proof.timelineId === tx.plan.edit.timelineId && proof.name === tx.plan.edit.oldName, 'name-native-proof');
  need(opened?.status === 'verified-open' && opened.readOnly === true && opened.doNotReplay === true
    && opened.contentSettersPerformed === false && opened.saveCloseLoadPerformed === false
    && opened.resolveVersion === '21.1.2.10' && opened.isStudio === false
    && opened.transactionId === tx.transactionId && opened.planId === tx.plan.planId
    && opened.projectId === tx.plan.projectId && opened.timelineId === tx.plan.edit.timelineId
    && opened.itemId === tx.plan.edit.itemId && opened.expectedDatabaseSha256 === tx.source.sha256
    && opened.storedName === tx.plan.edit.oldName
    && opened.actualOpenFileBindingVerified === true && opened.sourceBinding.actualOpenFileBindingVerified === true
    && opened.sourceBinding.source.path === tx.source.path && opened.sourceBinding.source.sha256 === tx.source.sha256
    && closed?.sha256 === tx.source.sha256 && closed.sourcePath === tx.source.path
    && closed.openFileAbsenceObservedTwice === true && closed.installedBuild.version === '21.1.2'
    && closed.installedBuild.build === '21.1.20010' && closed.processChecks.before.length === 0
    && closed.processChecks.after.length === 0, 'name-editor-admission');
  same(closed.metadata, context.observation.metadata);
  need(opened.sourceBinding.configSha256 === context.sourceBinding.configSha256
    && context.sourceBinding.sourcePath === tx.source.path && context.sourceBinding.projectName === tx.plan.projectName,
  'name-configuration-binding');
  const filename = mapped(live, NAME_RUN, tx.backup.path), inspected = await inspectRetainedNative(filename);
  const oldCensusBytes = await read(filename + '.census.json', true);
  same(inspected.censusSummary, summary(JSON.parse(oldCensusBytes)));
  need(sha(inspected.bytes) === tx.source.sha256 && inspected.bytes.length === tx.source.bytes
    && inspected.identity.projectId === tx.plan.projectId && inspected.identity.projectName === tx.plan.projectName, 'name-project-binding');
  require('../src/closed-project-apply-plan').verifyClosedProjectApplyPlan(tx.plan, {
    sources: Object.fromEntries(Object.entries(context.sources).map(([key, value]) => [key, Buffer.from(value, 'base64')])),
    plan: context.reviewPlan, audit: context.audit, databaseBytes: inspected.bytes, censusBytes: oldCensusBytes });
  const preservation = require('../phase-0/preservation-closed-copy-evidence').auditClosedCopyPreservation();
  need(preservation.postEditorDatabaseBytesIdentical === true && preservation.sdkSavePreservationProven === false, 'preservation-boundary');
  const payload = JSON.parse(require('node:zlib').gunzipSync(await read(relative(root,
    'phase-0/preservation-closed-copy-evidence/evidence.json.gz'))));
  need(payload.execution.postSnapshot.sha256 === tx.source.sha256, 'preservation-source-binding');
  return { id: 'closed-native-name-baseline', kind: 'saved-native-database', format: 'Resolve Project.db',
    editor: contract.PERSONAL_COMPATIBILITY_TARGET, historicalOsPatch: 'unrecorded',
    provenance: 'closed-checkpoint-open-readback-and-restoration', sdkSavePreservationProven: false,
    sourceSha256: sha(inspected.bytes), sourceBytes: inspected.bytes.length, census: inspected.censusSummary,
    projectId: inspected.identity.projectId, projectNameSha256: sha(inspected.identity.projectName),
    proof: { receipt: NAME_RECEIPT, receiptSha256: sha(receiptBytes), transactionId: tx.transactionId,
      nativeProofSha256: proof.proofSha256, authenticatedEvents: tx.journal.events,
      retainedNativeFile: path.relative(root, filename) } };
}

async function mediaCase(root, retentionDirectory) {
  const receiptBytes = await read(relative(root, MEDIA_RECEIPT)), receipt = JSON.parse(receiptBytes);
  need(receipt.schemaVersion === 1 && receipt.nativeWriteAuthority === false && receipt.losslessNativeImportProven === false, 'media-receipt');
  const retained = retentionDirectory || relative(root, receipt.privateRetentionDirectory), manifestBytes = await read(path.join(retained, 'manifest.json'), true);
  need(sha(manifestBytes) === receipt.manifestSha256, 'media-manifest');
  const manifest = JSON.parse(manifestBytes);
  for (const [file, expected] of Object.entries(manifest.files)) need(sha(await read(relative(retained, file), true)) === expected, 'media-artifact');
  await read(path.join(retained, 'store/host.key'), true);
  const record = await require('../src/media-relink-service').createMediaRelinkService({ directory: path.join(retained, 'store') }).read(receipt.intentId);
  const proof = record.importProof, { proofSha256, ...body } = proof, prepared = record.importCheck.prepared, request = prepared.request;
  const { planId, ...planBody } = record.plan;
  need(record.state === 'import-validated' && proofSha256 === receipt.importProofSha256 && sha(JSON.stringify(body)) === proofSha256
    && sha(JSON.stringify(planBody)) === planId && planId === receipt.planId
    && record.sourceHash === receipt.sourceSha256 && record.copy.sha256 === receipt.copySha256
    && proof.verified === true && proof.losslessNativeImportProven === false && proof.existingNativeProjectWritten === false
    && proof.intentId === record.intentId && proof.planId === planId && proof.closed === true && proof.savedReopened === true
    && proof.readback.status === 'imported'
    && proof.nativeSourceSha256 === receipt.nativeSha256 && prepared.requestSha256 === sha(JSON.stringify(request) + '\n')
    && request.intentId === record.intentId && request.planId === record.plan.planId
    && request.copySha256 === receipt.copySha256 && request.copyPath === record.copy.path && request.projectName === prepared.projectName
    && request.nativePath === prepared.nativePath
    && prepared.projectName === 'Frameline Media Review ' + request.token.slice(0, 12)
    && prepared.nativePath === path.join(request.library.libraryRoot, 'Resolve Projects/Users/guest/Projects', prepared.projectName, 'Project.db'), 'media-signed-proof');
  const attempt = mapped(retained, manifest.originalRoot, prepared.directory), program = await read(mapped(retained, manifest.originalRoot, prepared.scriptPath), true);
  need(sha(Buffer.from(request.library.configBytesBase64, 'base64')) === request.library.configSha256, 'media-configuration');
  need(program.equals(Buffer.from(await require('../src/media-relink-import').renderMediaRelinkImport(prepared)))
    && sha(program) === prepared.sourceSha256 && (await read(path.join(attempt, 'request.json'), true)).toString() === JSON.stringify(request) + '\n', 'media-program');
  const result = await json(path.join(attempt, 'result.json'), true);
  same(result, proof.readback.result); same(result.before, result.after);
  need(result.operation === 'fcpxml-derived-proxy-review-result' && result.token === request.token
    && result.requestSha256 === prepared.requestSha256 && result.savedReopened === true
    && result.closed === true && result.newDerivedProjectOnly === true && result.existingProjectWritten === false
    && result.losslessNativeImportProven === false && result.projectId === proof.projectId
    && result.projectName === prepared.projectName && result.after.projectId === proof.projectId, 'media-result');
  for (const phase of [0, 1, 2]) {
    const bytes = await read(path.join(attempt, 'admission-' + phase + '.json'), true), admission = JSON.parse(bytes);
    same(admission, proof.readback.admissions[phase]);
    need(admission.token === request.token && admission.requestSha256 === prepared.requestSha256 && admission.phase === phase
      && sha(bytes) === result[['hostAdmissionReceiptZero', 'hostAdmissionReceiptOne', 'hostAdmissionReceiptTwo'][phase]], 'media-admission');
    need((await read(path.join(attempt, 'ticket-' + phase + '.txt'), true)).toString()
      === 'FRAMELINE_MEDIA_IMPORT:' + request.token + ':' + prepared.requestSha256 + ':' + phase + ':' + sha(bytes) + '\n', 'media-ticket');
    if (phase === 0) need(admission.emptyWorkspace.operation === 'resolve-no-open-project-database'
      && admission.emptyWorkspace.noOpenProjectDatabaseVerified === true
      && admission.emptyWorkspace.configSha256 === request.library.configSha256, 'media-precreate');
    else need(admission.projectId === proof.projectId && admission.sourceBinding.actualOpenFileBindingVerified === true
      && admission.sourceBinding.source.path === prepared.nativePath
      && admission.sourceBinding.source.sha256 === admission.nativeSourceHash
      && admission.sourceBinding.configSha256 === request.library.configSha256
      && admission.sourceBinding.concurrentWriterResistanceProven === false, 'media-open-file');
  }
  need(request.clips.length === 50 && result.after.clips.length === 50, 'media-size');
  const ids = new Set();
  result.after.clips.forEach((clip, index) => {
    need(typeof clip.itemId === 'string' && !ids.has(clip.itemId) && typeof clip.mediaPoolId === 'string', 'media-occurrence-identity');
    ids.add(clip.itemId);
    for (const key of ['originalPath', 'proxyPath', 'offsetFrames', 'durationFrames', 'sourceInFrames']) same(clip[key], request.clips[index][key]);
  });
  const original = await read(path.join(retained, 'source.fcpxml'), true), copy = await read(path.join(retained, 'copy.fcpxml'), true);
  need(sha(original) === receipt.sourceSha256 && sha(copy) === receipt.copySha256, 'media-xml');
  same(require('../src/media-relink-xml').verifyMediaRelinkPatch(original, copy, record.plan.replacements), record.plan.proof);
  const closed = proof.closedObservation;
  need(closed.operation === 'derived-project-readonly-closed-observation' && closed.readOnly === true
    && closed.nativeWriteAuthority === false && closed.safeToApply === false && closed.concurrentWriterResistanceProven === false
    && closed.sourceMetadataChanged === false && closed.noOpenFilesBeforeAndAfter === true
    && closed.processesBefore.length === 0 && closed.processesAfter.length === 0
    && closed.installedBuild.version === '21.1.2' && closed.installedBuild.build === '21.1.20010'
    && closed.sha256 === receipt.nativeSha256 && proof.readback.admissions[2].nativeSourceHash === closed.sha256
    && closed.projectId === proof.projectId && closed.projectName === prepared.projectName, 'media-closed-proof');
  const filename = path.join(retained, 'derived-Project.db'), inspected = await inspectRetainedNative(filename);
  need(sha(inspected.bytes) === receipt.nativeSha256 && inspected.identity.projectId === proof.projectId
    && inspected.identity.projectName === prepared.projectName, 'media-native-binding');
  return { id: 'editor-saved-proxy-review', kind: 'saved-native-database', format: 'Resolve Project.db',
    editor: contract.PERSONAL_COMPATIBILITY_TARGET, historicalOsPatch: 'unrecorded',
    provenance: 'sdk-save-reopen-three-admissions', representedPictureOccurrences: 50, losslessNativeImportProven: false,
    sourceSha256: sha(inspected.bytes), sourceBytes: inspected.bytes.length, census: inspected.censusSummary,
    projectId: inspected.identity.projectId, projectNameSha256: sha(inspected.identity.projectName),
    proof: { receipt: MEDIA_RECEIPT, receiptSha256: sha(receiptBytes), intentId: record.intentId,
      nativeProofSha256: proofSha256, authenticatedEvents: record.journal.count,
      retainedNativeFile: path.relative(root, filename) } };
}

async function facts({ root = ROOT, nameRetentionDirectory, mediaRetentionDirectory } = {}) {
  const report = inspectCorpus();
  need(report.releaseSupportRange === null && report.releaseVersionCoverageProven === false, 'historical-release-scope');
  const exports = [];
  for (const [index, entry] of exportsCatalog.entries.entries()) {
    // Existing reader verifies stored/decompressed hashes and the production
    // parser's complete expected count/frame/warning result.
    const source = report.entries[index];
    exports.push({ id: 'editor-export-' + (index + 1), kind: 'editor-export', format: 'FCPXML', formatVersion: '1.10',
      editor: contract.PERSONAL_COMPATIBILITY_TARGET, file: entry.file, compression: entry.compression,
      storedSha256: source.storedSha256, sourceSha256: source.sourceSha256, sourceBytes: source.sourceBytes,
      expected: source.expected, provenance: source.provenance, provenanceSha256: source.provenanceSha256,
      nativeRestorePoint: false });
  }
  return { exports, nativeProjects: [await nameCase(root, nameRetentionDirectory), await mediaCase(root, mediaRetentionDirectory)] };
}
async function buildPersonalCompatibilityCatalog(options = {}) {
  const root = options.root || ROOT, observed = await observePersonalHost(), corpus = await facts(options);
  return { schemaVersion: 1, operation: 'owner-installed-build-compatibility-corpus',
    personalSupportRange: [contract.PERSONAL_COMPATIBILITY_TARGET], currentHostObservation: observed,
    releaseSupportRange: null, releaseVersionCoverageProven: false, releaseSupported: false,
    safeToApply: false, executionAuthority: false, operations: contract.PERSONAL_COMPATIBILITY_OPERATIONS, ...corpus,
    sourceHashes: Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file, sha(await read(relative(root, file)))]))) };
}
async function auditPersonalCompatibility({ root = ROOT, catalog, checkHost = false, ...options } = {}) {
  const value = contract.validatePersonalCompatibilityCatalog(catalog || await json(relative(root, CATALOG)));
  same(Object.keys(value.sourceHashes).sort(), SOURCE_FILES.slice().sort());
  for (const file of SOURCE_FILES) need(value.sourceHashes[file] === sha(await read(relative(root, file))), 'source:' + file);
  const actual = await facts({ root, ...options });
  same(actual.exports, value.exports); same(actual.nativeProjects, value.nativeProjects);
  if (checkHost) {
    const observed = await observePersonalHost();
    same(observed.target, value.currentHostObservation.target); same(observed.host, value.currentHostObservation.host);
    need(observed.installedInfoSha256 === value.currentHostObservation.installedInfoSha256, 'installed-info-changed');
  }
  return { verified: true, operation: 'audit-personal-installed-build-compatibility', personalEditorTargets: 1,
    editorExports: actual.exports.length, savedNativeProjects: actual.nativeProjects.length,
    productionNativeCensusesRecomputed: 2, savedDerivedPictureOccurrences: 50,
    exactHistoricalOsPatchKnown: false, currentHostReobserved: checkHost,
    canonicalEditorFilesOpened: false, nativeWritesPerformed: false,
    releaseSupportRange: null, releaseVersionCoverageProven: false, releaseSupported: false,
    safeToApply: false, executionAuthority: false };
}
module.exports = { auditPersonalCompatibility, buildPersonalCompatibilityCatalog, observePersonalHost, SOURCE_FILES, CATALOG };
if (require.main === module) (async () => {
  const args = process.argv.slice(2);
  need(args.length === 0 || args.length === 1 && args[0] === '--write-catalog', 'command');
  if (args[0]) {
    const value = await buildPersonalCompatibilityCatalog(); contract.validatePersonalCompatibilityCatalog(value);
    await fs.writeFile(relative(ROOT, CATALOG), JSON.stringify(value, null, 2) + '\n');
  }
  console.log(JSON.stringify(await auditPersonalCompatibility({ checkHost: true })));
})().catch(error => {
  const code = /^personal-(?:corpus|compatibility)-[a-z0-9-]+$/.test(error.message || '')
    ? error.message : 'personal-corpus-verification-failed';
  console.error(JSON.stringify({ verified: false, errorCode: code })); process.exitCode = 1;
});
