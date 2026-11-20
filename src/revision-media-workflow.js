'use strict';
// Personal/self-hosted media workflow. Canonical requirements always come from
// the selected immutable service revision, never a renderer-provided asset list.
const fs = require('node:fs/promises');
const path = require('node:path');
const { fingerprint } = require('./project-api-contracts');
const { validateRevisionManifest } = require('./revision-manifest');
const { validateIdentity, validateAvailability, validatePolicy } = require('./asset-http-transport');
const { classifyMediaAvailability } = require('./media-storage-policy');
const defaultEngine = require('./asset-file-transfer');
const { scanFcpXml, verifyFcpXmlSource } = require('./fcpxml-adapter');
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, ASSET = /^sha256:[a-f0-9]{64}$/;
const DAY = 86400000, LIMIT = 1000;
const fail = code => Object.assign(new Error(code), { code });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === keys.slice().sort().join('|');
const identifier = value => typeof value === 'string' && ID.test(value);
const filename = value => typeof value === 'string' && value.length <= 8192 && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value);
function check(signal) { if (signal?.aborted) throw fail('revision-media-cancelled'); }
function dependencies(manifest) {
  try { validateRevisionManifest(manifest); } catch { throw fail('revision-media-manifest-invalid'); }
  const deps = manifest.mediaDependencies;
  if (manifest.schemaVersion !== 3 || !deps || deps.version !== 1 || !['complete', 'incomplete'].includes(deps.coverage)
    || !Array.isArray(deps.assets) || deps.assets.length > LIMIT) throw fail('revision-media-binding-required');
  const seen = new Set(), unique = new Map();
  for (const item of deps.assets) {
    if (!exact(item, ['referenceId', 'identity', 'required']) || !identifier(item.referenceId) || seen.has(item.referenceId)
      || typeof item.required !== 'boolean') throw fail('revision-media-manifest-invalid');
    seen.add(item.referenceId); const identity = validateIdentity(item.identity), previous = unique.get(identity.contentId);
    if (previous && fingerprint(previous.identity) !== fingerprint(identity)) throw fail('revision-media-manifest-invalid');
    if (previous) { previous.referenceIds.push(item.referenceId); previous.required ||= item.required; }
    else unique.set(identity.contentId, { identity, referenceIds: [item.referenceId], required: item.required });
  }
  return { coverage: deps.coverage, assets: [...unique.values()].sort((a, b) => a.identity.contentId.localeCompare(b.identity.contentId)) };
}
function collaboratorReport(report, selected, assets, at) {
  if (report === null || report === undefined) return new Set();
  if (!exact(report, ['schemaVersion', 'source', 'projectId', 'revisionId', 'manifestId', 'observedAt', 'expiresAt', 'assets'])
    || report.schemaVersion !== 1 || report.source !== 'owner-attested-collaborator' || report.projectId !== selected.projectId
    || report.revisionId !== selected.revisionId || report.manifestId !== selected.manifestId
    || !Number.isSafeInteger(report.observedAt) || report.observedAt < 0 || report.observedAt > at
    || !Number.isSafeInteger(report.expiresAt) || report.expiresAt <= at || report.expiresAt <= report.observedAt
    || report.expiresAt - report.observedAt > DAY || !Array.isArray(report.assets) || report.assets.length > LIMIT) throw fail('revision-media-observation-invalid');
  const known = new Map(assets.map(item => [item.identity.contentId, item.identity])), seen = new Set();
  for (const raw of report.assets) {
    let identity; try { identity = validateIdentity(raw); } catch { throw fail('revision-media-observation-invalid'); }
    if (seen.has(identity.contentId) || !known.has(identity.contentId) || fingerprint(identity) !== fingerprint(known.get(identity.contentId))) throw fail('revision-media-observation-invalid');
    seen.add(identity.contentId);
  }
  return seen;
}

function createRevisionMediaWorkflow({ revisionClient, assetClient, engine = defaultEngine, now = Date.now } = {}) {
  if (!revisionClient || !['getAccount', 'listProjects', 'putManifest', 'createRevision', 'compareAndSwapBranch', 'getRevision', 'getManifest'].every(key => typeof revisionClient[key] === 'function')
    || !assetClient || !['getPolicy', 'getAvailability', 'getAsset', 'readChunk'].every(key => typeof assetClient[key] === 'function')
    || !['inspectAssetFile', 'uploadAssetFile', 'downloadAssetFile'].every(key => typeof engine[key] === 'function') || typeof now !== 'function') throw fail('revision-media-input-invalid');
  async function owner(projectId, signal, expected = null) {
    check(signal); if (!identifier(projectId)) throw fail('revision-media-input-invalid');
    const account = await revisionClient.getAccount({ signal }), projects = await revisionClient.listProjects({ signal }); check(signal);
    if (!identifier(account?.id) || account.status !== 'active' || expected !== null && account.id !== expected
      || !Array.isArray(projects?.projects) || !projects.projects.some(item => item.id === projectId && item.role === 'owner')) throw fail('revision-media-owner-required');
    return account.id;
  }
  async function selected(projectId, revisionId, signal) {
    if (!identifier(revisionId)) throw fail('revision-media-input-invalid');
    const accountId = await owner(projectId, signal), revision = await revisionClient.getRevision(projectId, revisionId, { signal });
    if (!revision || revision.id !== revisionId || revision.projectId !== projectId || !ASSET.test(revision.manifestId || '')) throw fail('revision-media-manifest-invalid');
    const stored = await revisionClient.getManifest(projectId, revision.manifestId, { signal }); check(signal);
    if (!stored || stored.id !== revision.manifestId || stored.projectId !== projectId || stored.id !== `sha256:${fingerprint(stored.document)}`) throw fail('revision-media-manifest-invalid');
    const bound = dependencies(stored.document); await owner(projectId, signal, accountId);
    return { projectId, revisionId, manifestId: stored.id, accountId, manifest: stored.document, ...bound };
  }
  async function localCopies(files, bound, controls) {
    if (!Array.isArray(files) || files.length > LIMIT || files.some(value => !filename(value))) throw fail('revision-media-input-invalid');
    const known = new Map(bound.assets.map(item => [item.identity.contentId, item.identity])), copies = new Map();
    for (const sourcePath of files) {
      check(controls.signal);
      const { identity } = await engine.inspectAssetFile(sourcePath, { signal: controls.signal, onProgress: controls.onProgress });
      const expected = known.get(identity.contentId);
      if (expected && identity.size === expected.size && !copies.has(identity.contentId)) copies.set(identity.contentId, sourcePath);
    }
    return copies;
  }
  async function observe(bound, { localFiles = [], collaboratorObservation = null } = {}, controls = {}) {
    const at = now(); if (!Number.isSafeInteger(at) || at < 0) throw fail('revision-media-input-invalid');
    const local = await localCopies(localFiles, bound, controls), reported = collaboratorReport(collaboratorObservation, bound, bound.assets, at);
    const policy = validatePolicy(await assetClient.getPolicy(bound.projectId, { signal: controls.signal }));
    if (policy.projectId !== bound.projectId) throw fail('revision-media-manifest-invalid');
    const items = [];
    for (const item of bound.assets) {
      check(controls.signal); const identity = item.identity;
      const remote = validateAvailability(await assetClient.getAvailability(bound.projectId, identity.contentId, { signal: controls.signal }));
      if (remote.projectId !== bound.projectId || remote.assetId !== identity.contentId || remote.cloudPresent
        && (remote.size !== identity.size || remote.assetClass !== identity.assetClass)) throw fail('revision-media-manifest-invalid');
      const evidence = classifyMediaAvailability({ localVerified: local.has(identity.contentId), cloudPresent: remote.cloudPresent,
        collaboratorPresent: reported.has(identity.contentId), excluded: remote.excluded || !policy.syncClasses.includes(identity.assetClass), archived: remote.archived });
      items.push({ contentId: identity.contentId, size: identity.size, assetClass: identity.assetClass,
        referenceIds: item.referenceIds, required: item.required, ...evidence });
    }
    const checked = validatePolicy(await assetClient.getPolicy(bound.projectId, { signal: controls.signal }));
    if (fingerprint(checked) !== fingerprint(policy)) throw fail('revision-media-policy-changed');
    await owner(bound.projectId, controls.signal, bound.accountId);
    return { local, report: { schemaVersion: 1, projectId: bound.projectId, revisionId: bound.revisionId, manifestId: bound.manifestId,
      scope: 'checked-locations', coverage: bound.coverage, collaboratorEvidence: collaboratorObservation ? 'owner-attested-report' : 'none',
      missingMeaning: 'No verified local or service copy, or unexpired reported collaborator copy, among the checked locations.',
      ready: bound.coverage === 'complete' && items.filter(item => item.required).every(item => item.localVerified || item.state === 'cloud-present'), items } };
  }
  async function publish(input, controls = {}) {
    const { projectId, exportPath, branch, expectedHead, message, idempotencyKey, uploadMedia, maxBytesPerSecond = null } = input || {};
    if (!filename(exportPath) || !['.fcpxml', '.fcpxmld'].includes(path.extname(exportPath).toLowerCase()) || !identifier(branch) || !identifier(idempotencyKey)
      || expectedHead !== null && !identifier(expectedHead) || typeof message !== 'string' || !message.trim() || message.length > 240
      || typeof uploadMedia !== 'boolean') throw fail('revision-media-input-invalid');
    const accountId = await owner(projectId, controls.signal);
    const manifest = await scanFcpXml(exportPath, { signal: controls.signal });
    const captured = await require('./media-revision-manifest').captureMediaRevision({ exportPath, manifest, signal: controls.signal, onProgress: controls.onProgress });
    const bound = dependencies(captured.manifest), sources = new Map();
    if (uploadMedia && bound.coverage !== 'complete') throw fail('revision-media-coverage-incomplete');
    for (const source of captured.sources) {
      const identity = validateIdentity(source.identity);
      if (!filename(source.sourcePath) || !bound.assets.some(item => fingerprint(item.identity) === fingerprint(identity))) throw fail('revision-media-manifest-invalid');
      sources.set(identity.contentId, source.sourcePath);
    }
    const uploaded = [];
    if (uploadMedia) for (const item of bound.assets) {
      check(controls.signal); if (!sources.has(item.identity.contentId)) throw fail('revision-media-source-unavailable');
      await owner(projectId, controls.signal, accountId);
      const result = await engine.uploadAssetFile({ client: assetClient, projectId, filename: sources.get(item.identity.contentId),
        identity: item.identity, signal: controls.signal, onProgress: controls.onProgress, maxBytesPerSecond });
      if (result?.assetId !== item.identity.contentId || result.size !== item.identity.size || result.verified !== true) throw fail('revision-media-manifest-invalid');
      uploaded.push(item.identity.contentId);
    }
    await verifyFcpXmlSource(exportPath, captured.manifest.sourceHash, { signal: controls.signal });
    await owner(projectId, controls.signal, accountId);
    const manifestId = `sha256:${fingerprint(captured.manifest)}`, stored = await revisionClient.putManifest(projectId, captured.manifest, { signal: controls.signal });
    if (stored?.id !== manifestId) throw fail('revision-media-manifest-invalid');
    await verifyFcpXmlSource(exportPath, captured.manifest.sourceHash, { signal: controls.signal });
    const key = fingerprint({ accountId, projectId, idempotencyKey });
    const revision = await revisionClient.createRevision({ projectId, manifestId, parentRevisionId: expectedHead, message,
      sourceRevisionId: `media-${key}`, idempotencyKey: `media-revision-${key}`, requireMedia: uploadMedia === true }, { signal: controls.signal });
    if (!revision || !identifier(revision.id) || revision.projectId !== projectId || revision.manifestId !== manifestId
      || revision.parentRevisionId !== expectedHead || revision.authorId !== accountId) throw fail('revision-media-manifest-invalid');
    await owner(projectId, controls.signal, accountId); check(controls.signal);
    const updated = await revisionClient.compareAndSwapBranch({ projectId, branch, revisionId: revision.id, expectedRevisionId: expectedHead,
      idempotencyKey: `media-branch-${key}` }, { signal: controls.signal });
    if (updated?.projectId !== projectId || updated.branch !== branch || updated.revisionId !== revision.id) throw fail('revision-media-manifest-invalid');
    return { schemaVersion: 1, projectId, branch, revisionId: revision.id, manifestId, sourceHash: captured.manifest.sourceHash,
      coverage: bound.coverage, references: captured.manifest.mediaDependencies.assets.length, uniqueAssets: bound.assets.length, uploaded };
  }
  async function availability(input, controls = {}) {
    const bound = await selected(input?.projectId, input?.revisionId, controls.signal);
    return (await observe(bound, input, controls)).report;
  }
  async function download(input, controls = {}) {
    const { destinationDirectory, workDirectory, maxBytesPerSecond = null } = input || {};
    if (!filename(destinationDirectory) || !filename(workDirectory)) throw fail('revision-media-input-invalid');
    const bound = await selected(input.projectId, input.revisionId, controls.signal), { local, report } = await observe(bound, input, controls);
    if (!report.ready) throw fail(bound.coverage !== 'complete' ? 'revision-media-coverage-incomplete' : 'revision-media-download-blocked');
    const destination = await fs.realpath(destinationDirectory), work = await fs.realpath(workDirectory);
    if (destination !== path.resolve(destinationDirectory) || work !== path.resolve(workDirectory)
      || !(await fs.stat(destination)).isDirectory() || !(await fs.stat(work)).isDirectory()
      || destination === work || destination.startsWith(`${work}${path.sep}`) || work.startsWith(`${destination}${path.sep}`)) throw fail('revision-media-input-invalid');
    const results = [];
    for (const item of bound.assets.filter(item => item.required)) {
      check(controls.signal); await owner(bound.projectId, controls.signal, bound.accountId);
      if (local.has(item.identity.contentId)) {
        const { identity } = await engine.inspectAssetFile(local.get(item.identity.contentId), { signal: controls.signal, onProgress: controls.onProgress });
        if (identity.contentId !== item.identity.contentId || identity.size !== item.identity.size) throw fail('revision-media-source-changed');
        results.push({ contentId: item.identity.contentId, status: 'verified-local', size: identity.size }); continue;
      }
      const metadata = await assetClient.getAsset(bound.projectId, item.identity.contentId, { signal: controls.signal });
      if (fingerprint(metadata?.identity) !== fingerprint(item.identity)) throw fail('revision-media-manifest-invalid');
      let receipt, publicationFailure = null;
      try { receipt = await engine.downloadAssetFile({ client: assetClient, projectId: bound.projectId, assetId: item.identity.contentId,
        destination: path.join(destination, item.identity.contentId.slice(7)), workDirectory: path.join(work, fingerprint([bound.accountId, bound.projectId, bound.revisionId, item.identity.contentId])),
        signal: controls.signal, onProgress: async progress => {
          await controls.onProgress?.(progress); check(controls.signal);
          // The engine calls this after fsync and before exclusive publication.
          // Cached chunks must not bypass a freshly revoked service policy.
          if (progress.phase === 'verifying') {
            try {
              await owner(bound.projectId, controls.signal, bound.accountId);
              const fresh = validateAvailability(await assetClient.getAvailability(bound.projectId, item.identity.contentId, { signal: controls.signal }));
              if (fresh.projectId !== bound.projectId || fresh.assetId !== item.identity.contentId
                || fresh.cloudPresent && (fresh.size !== item.identity.size || fresh.assetClass !== item.identity.assetClass)) throw fail('revision-media-manifest-invalid');
              if (!fresh.cloudPresent) throw fail('asset-not-found');
              if (fresh.excluded) throw fail('asset-policy-excluded'); if (fresh.archived) throw fail('asset-archived');
            } catch (error) { publicationFailure = error; throw error; }
          }
        }, maxBytesPerSecond }); } catch (error) { throw publicationFailure || error; }
      if (receipt?.assetId !== item.identity.contentId || receipt.size !== item.identity.size || receipt.verified !== true) throw fail('revision-media-manifest-invalid');
      results.push({ contentId: item.identity.contentId, status: receipt.alreadyPresent ? 'already-present' : 'downloaded', size: receipt.size });
    }
    const current = await selected(bound.projectId, bound.revisionId, controls.signal);
    if (current.manifestId !== bound.manifestId || current.accountId !== bound.accountId) throw fail('revision-media-source-changed');
    return { schemaVersion: 1, projectId: bound.projectId, revisionId: bound.revisionId, manifestId: bound.manifestId,
      complete: true, coverage: 'complete', filenames: 'sha256 hex without prefix', results };
  }
  async function getPolicy({ projectId }, controls = {}) {
    const accountId = await owner(projectId, controls.signal), value = validatePolicy(await assetClient.getPolicy(projectId, { signal: controls.signal }));
    if (value.projectId !== projectId) throw fail('revision-media-manifest-invalid'); await owner(projectId, controls.signal, accountId); return value;
  }
  async function setPolicy({ projectId, input }, controls = {}) {
    if (!exact(input, ['expectedVersion', 'syncClasses']) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
      || !Array.isArray(input.syncClasses) || input.syncClasses.length > 5 || new Set(input.syncClasses).size !== input.syncClasses.length
      || input.syncClasses.some(value => !['original', 'proxy', 'audio', 'graphics', 'other'].includes(value)) || typeof assetClient.setPolicy !== 'function') throw fail('revision-media-input-invalid');
    const accountId = await owner(projectId, controls.signal), value = validatePolicy(await assetClient.setPolicy(projectId, input, { signal: controls.signal }));
    if (value.projectId !== projectId || value.version !== input.expectedVersion + 1 || fingerprint(value.syncClasses) !== fingerprint([...input.syncClasses].sort())) throw fail('revision-media-manifest-invalid');
    await owner(projectId, controls.signal, accountId); return value;
  }
  return { publish, availability, download, getPolicy, setPolicy };
}
module.exports = { createRevisionMediaWorkflow };
