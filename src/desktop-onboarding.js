const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const { createFirstRun, validWorkspaceId } = require('./first-run');
const { createLocalMetadataStore } = require('./local-metadata');
const fail = code => Object.assign(new Error(code), { code });
const MARKER_NAME = '.frameline-workspace.json';

async function verifyDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw fail('workspace-unavailable');
}
async function readWorkspaceId(directory) {
  await verifyDirectory(directory);
  const marker = await fs.open(path.join(directory, MARKER_NAME), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await marker.stat();
    if (!stat.isFile() || stat.size > 256) throw fail('workspace-unavailable');
    const value = JSON.parse(await marker.readFile('utf8'));
    if (!value || value.schemaVersion !== 1 || !validWorkspaceId(value.workspaceId)
      || Object.keys(value).length !== 2) throw fail('workspace-unavailable');
    return value.workspaceId;
  } finally { await marker.close(); }
}
async function verifyWorkspace(directory, expectedId) {
  if (await readWorkspaceId(directory) !== expectedId) throw fail('workspace-unavailable');
}
async function createWorkspaceMarker(directory) {
  const workspaceId = randomUUID();
  const marker = await fs.open(path.join(directory, MARKER_NAME), 'wx', 0o600);
  try { await marker.writeFile(JSON.stringify({ schemaVersion: 1, workspaceId })); await marker.sync(); }
  finally { await marker.close(); }
  const folder = await fs.open(directory, 'r');
  try { await folder.sync(); } finally { await folder.close(); }
  return workspaceId;
}

// The stable facade lets all desktop consumers share the selected revision store.
// A location can change only before any project operation has begun. Passive
// history discovery is drained before switching; calls during a switch fail closed.
async function createDesktopOnboarding({ directory, defaultDirectory }) {
  if (!path.isAbsolute(defaultDirectory || '')) throw fail('first-run-invalid');
  const settings = createFirstRun({ directory });
  let state = await settings.read(), activeDirectory = state.workspaceDirectory || defaultDirectory;
  let delegate = createLocalMetadataStore(activeDirectory), activeWorkspaceId = state.workspaceId;
  let used = false, changing = false, completing = false, uncertain = false, chosenDirectory = activeDirectory;
  const reads = new Set();
  const store = Object.fromEntries(Object.keys(delegate).map(method => [method, async (...args) => {
    if (uncertain) throw fail('workspace-unavailable');
    if (changing) throw fail('workspace-busy');
    if (method !== 'listResolveProjects') { used = true; chosenDirectory = activeDirectory; }
    const current = delegate, currentDirectory = activeDirectory, currentId = activeWorkspaceId;
    const operation = (async () => {
      if (currentId) {
        try { await verifyWorkspace(currentDirectory, currentId); }
        catch { throw fail('workspace-unavailable'); }
      }
      return current[method](...args);
    })();
    reads.add(operation);
    try { return await operation; } finally { reads.delete(operation); }
  }]));
  const getState = () => ({ ...state, workspaceDirectory: chosenDirectory, storageLocked: used || state.completed });
  async function chooseDirectory(parent) {
    if (uncertain) throw fail('workspace-unavailable');
    if (changing || completing || used || state.completed) throw fail('workspace-locked');
    changing = true;
    try {
      if (typeof parent !== 'string' || !path.isAbsolute(parent) || /[\x00-\x1f\x7f]/.test(parent)) throw fail('workspace-unavailable');
      const canonical = await fs.realpath(parent);
      if (!(await fs.stat(canonical)).isDirectory()) throw fail('workspace-unavailable');
      chosenDirectory = path.join(canonical, 'Frameline revisions');
      return getState();
    } catch { throw fail('workspace-unavailable'); }
    finally { changing = false; }
  }
  async function configure({ editor, workspaceName } = {}) {
    if (uncertain) throw fail('workspace-unavailable');
    if (changing || completing || state.completed || used && chosenDirectory !== activeDirectory) throw fail('workspace-locked');
    changing = true;
    let probe;
    try {
      await Promise.allSettled([...reads]);
      const custom = chosenDirectory !== defaultDirectory;
      const sameConfiguredWorkspace = state.workspaceDirectory === chosenDirectory;
      if (sameConfiguredWorkspace) await verifyWorkspace(chosenDirectory, state.workspaceId);
      else if (custom) {
        // Recheck the picker-selected parent. Never recreate a disconnected or
        // moved parent directory when initializing its workspace subfolder.
        await verifyDirectory(path.dirname(chosenDirectory));
        try { await fs.mkdir(chosenDirectory, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await verifyDirectory(chosenDirectory);
      } else await fs.mkdir(chosenDirectory, { recursive: true, mode: 0o700 });
      probe = path.join(chosenDirectory, `.frameline-write-check-${randomUUID()}`);
      await fs.writeFile(probe, '', { flag: 'wx', mode: 0o600 });
      let workspaceId = null;
      if (custom) {
        try { workspaceId = await readWorkspaceId(chosenDirectory); }
        catch (error) { if (error.code !== 'ENOENT' || sameConfiguredWorkspace) throw error; }
      }
      const candidate = createLocalMetadataStore(chosenDirectory);
      await candidate.listResolveProjects(); // Existing corrupt metadata must not be silently replaced.
      if (custom && !workspaceId) workspaceId = await createWorkspaceMarker(chosenDirectory);
      state = await settings.save({ editor, workspaceName, workspaceDirectory: custom ? chosenDirectory : null, workspaceId,
        completed: false, configured: true });
      activeDirectory = chosenDirectory; activeWorkspaceId = workspaceId; delegate = candidate;
      return getState();
    } catch (error) {
      if (error.code === 'first-run-storage-uncertain') uncertain = true;
      throw fail(error.code === 'first-run-invalid' ? error.code : 'workspace-unavailable');
    }
    finally { if (probe) await fs.rm(probe, { force: true }).catch(() => {}); changing = false; }
  }
  async function complete() {
    if (uncertain) throw fail('workspace-unavailable');
    if (state.completed || !state.configured) return getState();
    if (changing || completing) throw fail('workspace-busy');
    completing = true;
    try { state = await settings.save({ ...state, completed: true }); return getState(); }
    catch (error) { if (error.code === 'first-run-storage-uncertain') uncertain = true; throw error; }
    finally { completing = false; }
  }
  function useDefaultDirectory() {
    if (uncertain) throw fail('workspace-unavailable');
    if (changing || completing || used || state.completed) throw fail('workspace-locked');
    chosenDirectory = defaultDirectory;
    return getState();
  }
  return { store, getState, chooseDirectory, useDefaultDirectory, configure, complete };
}
module.exports = { createDesktopOnboarding };
