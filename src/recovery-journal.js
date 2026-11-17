const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
function createRecoveryJournal({ directory } = {}) {
  if (!path.isAbsolute(directory || '')) throw fail('recovery-journal-invalid');
  const filename = path.join(directory, 'operations.json');
  async function read() {
    try {
      const state = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.operations)) throw fail('recovery-journal-corrupt');
      return state;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw fail('recovery-journal-corrupt'); }
  }
  async function write(state) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async function begin({ type, projectId, sourceHash = null, transferId = null }) {
    if (!['scan', 'upload', 'apply'].includes(type) || !ID.test(projectId || '')
      || sourceHash !== null && !/^[a-f0-9]{64}$/.test(sourceHash)
      || transferId !== null && !ID.test(transferId)) throw fail('recovery-operation-invalid');
    const state = await read(); const operation = { id: randomUUID(), type, projectId, sourceHash,
      transferId, status: 'pending', startedAt: new Date().toISOString() };
    state.operations.push(operation); await write(state); return structuredClone(operation);
  }
  async function finish(id, status) {
    if (!['completed', 'failed'].includes(status)) throw fail('recovery-operation-invalid');
    const state = await read(); const operation = state.operations.find(item => item.id === id && item.status === 'pending');
    if (!operation) throw fail('recovery-operation-not-found');
    operation.status = status; await write(state); return structuredClone(operation);
  }
  async function pending() {
    const state = await read(); return state.operations.filter(item => item.status === 'pending').map(item => ({
      ...item, nextAction: item.type === 'scan' ? 'reselect-and-rescan' : item.type === 'upload' ? 'resume-verified-chunks' : 'manual-restore-required'
    }));
  }
  return { begin, finish, pending };
}
module.exports = { createRecoveryJournal };
