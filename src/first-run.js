const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EXPERIMENTAL_TARGET } = require('./compatibility-contract');
function fail(code) { const error = new Error(code); error.code = code; return error; }
function createFirstRun({ directory } = {}) {
  if (!path.isAbsolute(directory || '')) throw fail('first-run-invalid');
  const filename = path.join(directory, 'first-run.json');
  async function read() {
    try {
      const value = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (value.version !== 1 || value.editor !== EXPERIMENTAL_TARGET.onboardingEditorId || typeof value.workspaceName !== 'string'
        || value.workspaceName.length > 60 || typeof value.completed !== 'boolean') throw fail('first-run-invalid');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, editor: EXPERIMENTAL_TARGET.onboardingEditorId, workspaceName: 'Local workspace', completed: false }; throw fail('first-run-invalid'); }
  }
  async function save({ editor, workspaceName }) {
    if (editor !== EXPERIMENTAL_TARGET.onboardingEditorId || typeof workspaceName !== 'string'
      || !workspaceName.trim() || workspaceName.trim().length > 60 || /[\\/\x00-\x1f]/.test(workspaceName)) throw fail('first-run-invalid');
    const value = { version: 1, editor, workspaceName: workspaceName.trim(), completed: true };
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, { force: true }); }
    return value;
  }
  return { read, save };
}
module.exports = { createFirstRun };
