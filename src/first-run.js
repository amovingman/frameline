const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EXPERIMENTAL_TARGET } = require('./compatibility-contract');
function fail(code) { const error = new Error(code); error.code = code; return error; }
function validName(value) { return typeof value === 'string' && !!value.trim() && value.trim().length <= 60 && !/[\\/\x00-\x1f\x7f]/.test(value); }
function validDirectory(value) { return value === null || typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value); }
function validWorkspaceId(value) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value); }
function createFirstRun({ directory, storage = fs } = {}) {
  const fs = storage;
  if (!path.isAbsolute(directory || '')) throw fail('first-run-invalid');
  const filename = path.join(directory, 'first-run.json');
  async function read() {
    try {
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (![1, 2].includes(value.version) || value.editor !== EXPERIMENTAL_TARGET.onboardingEditorId || !validName(value.workspaceName)
        || typeof value.completed !== 'boolean' || value.version === 2 && (!validDirectory(value.workspaceDirectory) || typeof value.configured !== 'boolean'
          || value.completed && !value.configured || (value.workspaceDirectory === null ? value.workspaceId !== null : !validWorkspaceId(value.workspaceId)))) throw fail('first-run-invalid');
      return { version: 2, editor: value.editor, workspaceName: value.workspaceName.trim(), completed: value.completed,
        configured: value.version === 1 ? value.completed : value.configured, workspaceDirectory: value.version === 1 ? null : value.workspaceDirectory,
        workspaceId: value.version === 1 ? null : value.workspaceId };
    } catch (error) { if (error.code === 'ENOENT') return { version: 2, editor: EXPERIMENTAL_TARGET.onboardingEditorId, workspaceName: 'Local workspace', completed: false, configured: false, workspaceDirectory: null, workspaceId: null }; throw fail('first-run-invalid'); }
  }
  async function save({ editor, workspaceName, workspaceDirectory = null, workspaceId = null, completed = true, configured = true }) {
    if (editor !== EXPERIMENTAL_TARGET.onboardingEditorId || !validName(workspaceName) || !validDirectory(workspaceDirectory)
      || typeof completed !== 'boolean' || typeof configured !== 'boolean' || completed && !configured
      || (workspaceDirectory === null ? workspaceId !== null : !validWorkspaceId(workspaceId))) throw fail('first-run-invalid');
    const value = { version: 2, editor, workspaceName: workspaceName.trim(), workspaceDirectory, workspaceId, completed, configured };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      await fs.rename(temporary, filename); renamed = true;
      const folder = await fs.open(directory, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    } catch (error) {
      if (renamed) throw fail('first-run-storage-uncertain');
      throw error;
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    return value;
  }
  return { read, save };
}
module.exports = { createFirstRun, validWorkspaceId };
