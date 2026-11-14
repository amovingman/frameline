const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createProjectSession } = require('./project-session');
const { createLocalMetadataStore } = require('./local-metadata');
const { fcpxmlProjectAdapter } = require('./project-adapter');
const logger = require('./logger');
const { createResolveReviewSession } = require('./resolve-review-session');
const { prepareReviewCopySession } = require('./review-copy-session');
const { compareResolveSnapshotToExport } = require('./resolve-export-candidates');
const { verifyReviewCopy } = require('./review-copy-verifier');
const { auditFcpxmlMedia } = require('./fcpxml-media-audit');
const { resolveFolderCandidates, sanitizeResolutionReport,
  carryObservedIdentity, evaluateMediaRequirements } = require('./local-media-readiness');

let projectSession;
let resolveReviewSession;
let resolveSourcePaths = null;
let resolveBusy = false;
let selectedProjectPath = null;
let reviewCopyBusy = false;
let resolveExportPath = null;
let resolveExportTimelineId = null;
let resolveExportComparison = null;
let resolveExportError = null;
let resolveExportLocalHash = null;
let verifiedCopyPath = null;
let verifiedCopySourcePath = null;
let verifiedCopyHash = null;
let mediaAuditBusy = false;
let privateMediaAudits = {};
const RESOLVE_SOURCE_LIMIT = 20 * 1024 * 1024;

function currentCopyPath() {
  const state = projectSession.getState();
  return verifiedCopyPath && verifiedCopySourcePath === selectedProjectPath
    && verifiedCopyHash === state.scan?.sourceHash && state.scanStatus === 'ready'
    && state.selectedProject?.format === 'FCPXML' && !state.error
    ? verifiedCopyPath : null;
}

function copyUnavailable() {
  return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Choose and scan a regular FCPXML export before verifying a review copy.' } };
}

function copyNotVerified() {
  return { status: 'error', error: { code: 'review-copy-unverified', message: 'No verified copy is available for this export. Verify the copy again.' } };
}

function getResolveState(state = resolveReviewSession.getState()) {
  if (resolveExportLocalHash && state.sourceHashes?.local !== resolveExportLocalHash) {
    resolveExportComparison = null;
    resolveExportError = null;
    resolveExportLocalHash = null;
  }
  return { ...state, exportComparison: resolveExportComparison, exportError: resolveExportError };
}

async function readResolveExport(selectedPath) {
  const extension = path.extname(selectedPath).toLowerCase();
  if (!['.fcpxml', '.fcpxmld'].includes(extension)) throw Object.assign(new Error('Unsupported export.'), { code: 'resolve-export-invalid' });
  const filename = extension === '.fcpxmld' ? path.join(selectedPath, 'Info.fcpxml') : selectedPath;
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size <= 0 || stat.size > RESOLVE_SOURCE_LIMIT) throw Object.assign(new Error('Invalid export size.'), { code: 'resolve-export-invalid' });
  const bytes = await fs.readFile(filename);
  if (bytes.length !== stat.size) throw Object.assign(new Error('Export changed during read.'), { code: 'resolve-export-invalid' });
  return bytes;
}

async function readResolveSources(paths) {
  const sources = {};
  for (const role of ['base', 'local', 'incoming']) {
    const stat = await fs.stat(paths[role]);
    if (!stat.isFile() || stat.size <= 0 || stat.size > RESOLVE_SOURCE_LIMIT) {
      const error = new Error('Invalid Resolve snapshot size.');
      error.code = 'invalid-resolve-preview';
      throw error;
    }
    sources[role] = await fs.readFile(paths[role]);
    if (sources[role].length !== stat.size) {
      const error = new Error('Resolve snapshot changed while reading.');
      error.code = 'invalid-resolve-preview';
      throw error;
    }
  }
  return sources;
}

async function runResolveAction(action) {
  if (resolveBusy) return getResolveState({ ...resolveReviewSession.getState(), error: { code: 'resolve-review-busy', message: 'A Resolve review action is already running.' } });
  resolveBusy = true;
  try { return getResolveState(await action()); }
  catch (error) {
    logger.warn('resolve.review-failed', { code: error.code || 'resolve-review-error' });
    return getResolveState({ ...resolveReviewSession.getState(), error: { code: error.code || 'resolve-review-error', message: 'Could not complete the Resolve review action.' } });
  } finally { resolveBusy = false; }
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    title: 'Frameline',
    backgroundColor: '#141415',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.loadFile(path.join(__dirname, 'index.html'));
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  projectSession = createProjectSession(fcpxmlProjectAdapter, createLocalMetadataStore(app.getPath('userData')));
  const resolveArtifactDirectory = path.join(app.getPath('userData'), 'resolve-previews');
  resolveReviewSession = createResolveReviewSession({ artifactDirectory: resolveArtifactDirectory });
  logger.info('app.ready', { version: app.getVersion() });
  ipcMain.handle('app:get-state', () => projectSession.getState());
  ipcMain.handle('resolve:get-review-state', () => getResolveState());
  ipcMain.handle('resolve:choose-snapshots', () => runResolveAction(async () => {
    const paths = {};
    for (const role of ['base', 'local', 'incoming']) {
      const result = await dialog.showOpenDialog({
        title: `Choose ${role} Resolve snapshot`,
        properties: ['openFile'],
        filters: [{ name: 'Resolve API snapshot', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePaths.length) return resolveReviewSession.getState();
      paths[role] = result.filePaths[0];
    }
    const sources = await readResolveSources(paths);
    const state = resolveReviewSession.load(sources);
    if (state.status === 'ready') resolveSourcePaths = paths;
    return state;
  }));
  ipcMain.handle('resolve:refresh-preview', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:save-preview', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Preview refreshed; inspect it before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.save();
  }));
  ipcMain.handle('resolve:save-review', () => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    const refreshed = resolveReviewSession.refresh(await readResolveSources(resolveSourcePaths));
    if (refreshed.sourceVerification?.changed) return { ...refreshed, error: { code: 'resolve-source-changed', message: 'Snapshot files changed. Previous choices cleared; review the new comparison before saving.' } };
    if (refreshed.status !== 'ready') return refreshed;
    await fs.mkdir(resolveArtifactDirectory, { recursive: true, mode: 0o700 });
    return resolveReviewSession.saveReview();
  }));
  ipcMain.handle('resolve:recover-preview', (_event, artifactId) => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.recover(artifactId, await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:recover-review', (_event, artifactId) => runResolveAction(async () => {
    if (!resolveSourcePaths) return resolveReviewSession.getState();
    return resolveReviewSession.recoverReview(artifactId, await readResolveSources(resolveSourcePaths));
  }));
  ipcMain.handle('resolve:set-decision', (_event, conflictId, choice) => runResolveAction(
    () => resolveReviewSession.setDecision(conflictId, choice)));
  ipcMain.handle('resolve:choose-export', (_event, requestedTimelineId) => runResolveAction(async () => {
    if (!resolveSourcePaths) {
      resolveExportError = { code: 'resolve-export-unavailable', message: 'Choose the three Resolve snapshots before matching an export.' };
      return resolveReviewSession.getState();
    }
    const sources = await readResolveSources(resolveSourcePaths);
    const state = resolveReviewSession.refresh(sources);
    if (state.status !== 'ready') return state;
    const timelines = JSON.parse(sources.local.toString('utf8')).timelines;
    const timelineId = typeof requestedTimelineId === 'string' && requestedTimelineId !== 'all'
      ? requestedTimelineId : timelines.length === 1 ? timelines[0].id : null;
    if (!timelineId || !timelines.some(item => item.id === timelineId)) {
      resolveExportError = { code: 'resolve-export-select-timeline', message: 'Select one local timeline before matching an FCPXML export.' };
      return state;
    }
    const result = await dialog.showOpenDialog({
      title: 'Choose an FCPXML export for candidate matching',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'Resolve FCPXML export', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || !result.filePaths.length) return state;
    try {
      const exportBytes = await readResolveExport(result.filePaths[0]);
      resolveExportComparison = compareResolveSnapshotToExport(sources.local, exportBytes, timelineId);
      resolveExportPath = result.filePaths[0];
      resolveExportTimelineId = timelineId;
      resolveExportLocalHash = state.sourceHashes.local;
      resolveExportError = null;
    } catch (error) {
      resolveExportComparison = null;
      resolveExportError = { code: error.code || 'resolve-export-invalid', message: 'This export cannot be matched to the selected flat picture timeline.' };
    }
    return state;
  }));
  ipcMain.handle('resolve:refresh-export', () => runResolveAction(async () => {
    if (!resolveSourcePaths || !resolveExportPath || !resolveExportTimelineId) {
      resolveExportError = { code: 'resolve-export-unavailable', message: 'Choose an FCPXML export before refreshing its candidates.' };
      return resolveReviewSession.getState();
    }
    const sources = await readResolveSources(resolveSourcePaths);
    const state = resolveReviewSession.refresh(sources);
    if (state.status !== 'ready') return state;
    try {
      resolveExportComparison = compareResolveSnapshotToExport(sources.local,
        await readResolveExport(resolveExportPath), resolveExportTimelineId);
      resolveExportLocalHash = state.sourceHashes.local;
      resolveExportError = null;
    } catch (error) {
      resolveExportComparison = null;
      resolveExportLocalHash = null;
      resolveExportError = { code: error.code || 'resolve-export-invalid', message: 'The export or local snapshot changed. Choose a valid flat picture export again.' };
    }
    return state;
  }));
  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a DaVinci Resolve timeline',
      properties: ['openFile', 'treatPackageAsDirectory'],
      filters: [{ name: 'DaVinci Resolve timeline exchange', extensions: ['fcpxml', 'fcpxmld'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      logger.info('project.selection-cancelled');
      return projectSession.getState();
    }
    const selectedPath = result.filePaths[0];
    const state = await projectSession.select(selectedPath);
    selectedProjectPath = state.error === 'unsupported-format' ? null : selectedPath;
    verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
    privateMediaAudits = {};
    if (state.error === 'unsupported-format') {
      logger.warn('project.selection-rejected', { filePath: selectedPath });
    } else {
      logger.info('project.selected', {
        format: state.selectedProject.format,
        filePath: selectedPath
      });
      if (state.scanStatus === 'ready') logger.info('project.scan-complete', { clipCount: state.scan.clips.length, warningCount: state.scan.warnings.length });
      else logger.warn('project.scan-failed', { code: state.error });
    }
    return state;
  });
  ipcMain.handle('project:rescan', async () => {
    const previousHash = projectSession.getState().scan?.sourceHash;
    const state = await projectSession.rescan();
    if (state.scanStatus !== 'ready' || state.scan?.sourceHash !== verifiedCopyHash) {
      verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
    }
    if (state.scan?.sourceHash !== previousHash) privateMediaAudits = {};
    if (state.scanStatus === 'ready') logger.info('project.rescan-complete', { clipCount: state.scan.clips.length, warningCount: state.scan.warnings.length });
    else if (state.scanStatus === 'error') logger.warn('project.rescan-failed', { code: state.error });
    return state;
  });
  ipcMain.handle('project:prepare-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy is already being prepared.' } };
    const state = projectSession.getState();
    if (!selectedProjectPath || state.scanStatus !== 'ready' || state.selectedProject?.format !== 'FCPXML'
      || !state.scan?.sourceHash || state.error) {
      return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Choose and scan a regular FCPXML export before making a review copy.' } };
    }
    reviewCopyBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const extension = path.extname(sourcePath);
      const base = path.basename(sourcePath, extension);
      const result = await dialog.showSaveDialog({
        title: 'Choose a location for a verified review copy',
        defaultPath: `${base}-review.fcpxml`,
        filters: [{ name: 'FCPXML review copy', extensions: ['fcpxml'] }]
      });
      if (result.canceled || !result.filePath) return { status: 'canceled' };
      if (selectedProjectPath !== sourcePath
        || state.selectedProject.id !== projectSession.getState().selectedProject?.id) {
        return { status: 'error', error: { code: 'review-copy-unavailable', message: 'Project selection changed. Choose the current export and try again.' } };
      }
      const prepared = await prepareReviewCopySession({
        sourcePath,
        expectedSha256: state.scan.sourceHash,
        destinationDirectory: path.dirname(result.filePath),
        preferredFilename: path.basename(result.filePath)
      });
      if (prepared.status === 'ready' && selectedProjectPath === sourcePath
        && projectSession.getState().scan?.sourceHash === state.scan.sourceHash) {
        verifiedCopyPath = path.join(path.dirname(result.filePath), prepared.copyName);
        verifiedCopySourcePath = sourcePath;
        verifiedCopyHash = state.scan.sourceHash;
      }
      return prepared;
    } catch (error) {
      logger.warn('review-copy.failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to prepare a verified review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:verify-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy check is already running.' } };
    const state = projectSession.getState();
    if (!selectedProjectPath || state.scanStatus !== 'ready' || state.selectedProject?.format !== 'FCPXML'
      || !state.scan?.sourceHash || state.error) return copyUnavailable();
    reviewCopyBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const result = await dialog.showOpenDialog({
        title: 'Choose an unchanged FCPXML review copy to verify',
        properties: ['openFile'],
        filters: [{ name: 'FCPXML review copy', extensions: ['fcpxml'] }]
      });
      if (result.canceled || !result.filePaths.length) return { status: 'canceled' };
      if (selectedProjectPath !== sourcePath || projectSession.getState().scan?.sourceHash !== state.scan.sourceHash) return copyUnavailable();
      const copyPath = result.filePaths[0];
      const verified = await verifyReviewCopy({ sourcePath, copyPath, expectedSha256: state.scan.sourceHash });
      if (verified.status === 'ready' && selectedProjectPath === sourcePath
        && projectSession.getState().scan?.sourceHash === state.scan.sourceHash) {
        verifiedCopyPath = copyPath;
        verifiedCopySourcePath = sourcePath;
        verifiedCopyHash = state.scan.sourceHash;
      } else if (verified.status !== 'ready') {
        verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
      }
      return verified;
    } catch (error) {
      logger.warn('review-copy.verify-failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to verify the FCPXML review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:reveal-review-copy', async () => {
    if (reviewCopyBusy) return { status: 'error', error: { code: 'review-copy-busy', message: 'A review copy check is already running.' } };
    const copyPath = currentCopyPath();
    if (!copyPath) return copyNotVerified();
    reviewCopyBusy = true;
    try {
      const state = projectSession.getState();
      const verified = await verifyReviewCopy({ sourcePath: selectedProjectPath,
        copyPath, expectedSha256: state.scan.sourceHash });
      if (verified.status !== 'ready' || copyPath !== currentCopyPath()) {
        verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
        return verified.status === 'ready' ? copyNotVerified() : verified;
      }
      shell.showItemInFolder(copyPath);
      return verified;
    } catch (error) {
      logger.warn('review-copy.reveal-failed', { code: error.code || 'review-copy-failed' });
      return { status: 'error', error: { code: 'review-copy-failed', message: 'Unable to reveal the verified FCPXML review copy.' } };
    } finally { reviewCopyBusy = false; }
  });
  ipcMain.handle('project:audit-media', async (_event, target) => {
    if (mediaAuditBusy) return { status: 'error', error: { code: 'media-audit-busy', message: 'A media audit is already running.' } };
    const state = projectSession.getState();
    if (!['source', 'copy'].includes(target) || !selectedProjectPath || state.scanStatus !== 'ready'
      || state.selectedProject?.format !== 'FCPXML' || !state.scan?.sourceHash || state.error) {
      return { status: 'error', error: { code: 'media-audit-unavailable', message: 'Choose and scan a regular FCPXML export before auditing its media.' } };
    }
    const copyPath = target === 'copy' ? currentCopyPath() : null;
    if (target === 'copy' && !copyPath) return copyNotVerified();
    mediaAuditBusy = true;
    try {
      const sourcePath = selectedProjectPath;
      const expectedHash = state.scan.sourceHash;
      if (target === 'copy') {
        const verified = await verifyReviewCopy({ sourcePath, copyPath, expectedSha256: expectedHash });
        if (verified.status !== 'ready') {
          verifiedCopyPath = verifiedCopySourcePath = verifiedCopyHash = null;
          return verified;
        }
      }
      const report = await auditFcpxmlMedia({ exportPath: target === 'copy' ? copyPath : sourcePath,
        expectedSourceHash: expectedHash });
      if (selectedProjectPath !== sourcePath || projectSession.getState().scan?.sourceHash !== expectedHash) return copyUnavailable();
      report.assets = carryObservedIdentity(report.assets,
        privateMediaAudits[target]?.sourceHash === report.sourceHash ? privateMediaAudits[target].assets : []);
      privateMediaAudits[target] = report;
      const requirements = evaluateMediaRequirements({ schemaVersion: 1,
        items: report.assets.map(asset => ({ id: asset.id, required: true, state: asset.status,
          availabilityReason: asset.reason, verified: asset.identityVerified,
          reason: asset.identityVerified ? 'prior-size-and-hash-match'
            : asset.fingerprint ? 'expected-identity-unavailable' : 'original-unavailable' })) });
      return { status: 'ready', sourceHash: report.sourceHash, counts: report.counts,
        assets: report.assets.map(({ fingerprint, expectedFingerprint, ...asset }) => ({ ...asset,
          fingerprintAvailable: !!fingerprint, expectedIdentityAvailable: !!expectedFingerprint,
          size: fingerprint?.size ?? null })),
        requirements, identityVerified: false, error: null };
    } catch (error) {
      logger.warn('media.audit-failed', { code: error.code || 'media-audit-failed' });
      return { status: 'error', error: { code: 'media-audit-failed', message: 'Unable to audit media for this FCPXML export.' } };
    } finally { mediaAuditBusy = false; }
  });
  ipcMain.handle('project:find-media', async (_event, target) => {
    if (mediaAuditBusy) return { status: 'error', error: { code: 'media-audit-busy', message: 'A media check is already running.' } };
    const state = projectSession.getState();
    const audit = privateMediaAudits[target];
    if (!['source', 'copy'].includes(target) || !audit || state.scanStatus !== 'ready'
      || audit.sourceHash !== state.scan?.sourceHash) return { status: 'error', error: {
        code: 'media-search-unavailable', message: 'Run the media audit before choosing a search folder.' } };
    const unresolved = audit.assets.filter(asset => asset.status !== 'local' && asset.status !== 'excluded');
    if (!unresolved.length) return { status: 'ready', canceled: false,
      ...sanitizeResolutionReport({ items: [], resolvedCount: 0, ambiguousCount: 0 }) };
    const selected = await dialog.showOpenDialog({ title: 'Choose a folder to search for moved media', properties: ['openDirectory'] });
    if (selected.canceled || !selected.filePaths.length) return { status: 'ready', canceled: true };
    mediaAuditBusy = true;
    try {
      const result = await resolveFolderCandidates(selected.filePaths[0], unresolved.map(asset => ({
        id: asset.id, name: asset.displayNames[0] || 'Untitled media',
        expected: asset.expectedFingerprint || asset.fingerprint || undefined
      })));
      if (audit !== privateMediaAudits[target] || audit.sourceHash !== projectSession.getState().scan?.sourceHash) {
        return { status: 'error', error: { code: 'media-search-stale', message: 'The export changed. Run the media audit again.' } };
      }
      return { status: 'ready', canceled: false, ...sanitizeResolutionReport(result) };
    } catch (error) {
      logger.warn('media.search-failed', { code: error.code || 'media-search-failed' });
      return { status: 'error', error: { code: 'media-search-failed', message: 'The selected folder could not be searched safely.' } };
    } finally { mediaAuditBusy = false; }
  });
  ipcMain.handle('project:save-revision', async (_event, message) => {
    const state = await projectSession.saveRevision(message);
    if (state.revisionError) logger.warn('revision.save-failed', { code: state.revisionError });
    else if (state.revisionStatus === 'idle' && state.revisions.length) logger.info('revision.saved', { projectId: state.selectedProject.id, revisionId: state.revisions[0].id });
    return state;
  });
  ipcMain.handle('project:open-revision', async (_event, revisionId) => projectSession.openRevision(revisionId));
  ipcMain.handle('project:create-branch', async (_event, name) => projectSession.createBranch(name));
  ipcMain.handle('project:switch-branch', async (_event, name) => projectSession.switchBranch(name));
  ipcMain.handle('project:relink', async (_event, projectId) => projectSession.relinkProject(projectId));
  ipcMain.handle('project:export-revisions', async () => {
    try {
      const bundle = await projectSession.exportRevisions();
      const result = await dialog.showSaveDialog({
        title: 'Export revision backup',
        defaultPath: 'frameline-revisions.json',
        filters: [{ name: 'Frameline revision backup', extensions: ['json'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      const tempPath = `${result.filePath}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(tempPath, 'wx', 0o600);
        try { await handle.writeFile(`${JSON.stringify(bundle, null, 2)}\n`); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(tempPath, result.filePath);
      } finally { await fs.rm(tempPath, { force: true }).catch(() => {}); }
      return { revisionCount: bundle.records.length, branchCount: Object.keys(bundle.branches).length };
    } catch (error) {
      logger.warn('revision.export-failed', { code: error.code || 'metadata-unavailable' });
      return { error: error.code || 'metadata-unavailable' };
    }
  });
  ipcMain.handle('project:import-revisions', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import revision backup',
      properties: ['openFile'],
      filters: [{ name: 'Frameline revision backup', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths.length) return { canceled: true };
    try {
      const filePath = result.filePaths[0];
      const stat = await fs.stat(filePath);
      if (stat.size > 50 * 1024 * 1024) return { error: 'revision-transfer-too-large' };
      const bundle = JSON.parse(await fs.readFile(filePath, 'utf8'));
      return await projectSession.importRevisions(bundle);
    } catch (error) {
      const code = error instanceof SyntaxError ? 'revision-transfer-invalid' : error.code || 'metadata-unavailable';
      logger.warn('revision.import-failed', { code });
      return { error: code };
    }
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
