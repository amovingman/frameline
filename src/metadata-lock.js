const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function removeStaleLock(lockPath) {
  let stat;
  let content;
  try { stat = await fs.stat(lockPath); content = await fs.readFile(lockPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let owner;
  try { owner = JSON.parse(content); } catch { owner = null; }
  const validOwner = owner && typeof owner.token === 'string' && Number.isSafeInteger(owner.pid);
  const deadOwner = validOwner && !isProcessAlive(owner.pid);
  const abandonedWrite = !validOwner && Date.now() - stat.mtimeMs > 5000;
  if (!deadOwner && !abandonedWrite) return;
  const current = await fs.stat(lockPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs) {
    await fs.rm(lockPath, { force: true });
  }
}

async function acquireMetadataLock(directory, timeoutMs = 5000) {
  try { await fs.mkdir(directory, { recursive: true, mode: 0o700 }); }
  catch { throw Object.assign(new Error('metadata-unavailable'), { code: 'metadata-unavailable' }); }
  const lockPath = path.join(directory, 'metadata.lock');
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.sync();
      await handle.close();
      return async () => {
        let owner;
        try { owner = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
        catch { throw Object.assign(new Error('metadata-locked'), { code: 'metadata-locked' }); }
        if (owner.token !== token) throw Object.assign(new Error('metadata-locked'), { code: 'metadata-locked' });
        await fs.rm(lockPath);
      };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
      }
      if (error.code !== 'EEXIST') throw Object.assign(new Error('metadata-unavailable'), { code: 'metadata-unavailable' });
      try { await removeStaleLock(lockPath); }
      catch { throw Object.assign(new Error('metadata-unavailable'), { code: 'metadata-unavailable' }); }
      if (Date.now() >= deadline) throw Object.assign(new Error('metadata-locked'), { code: 'metadata-locked' });
      await sleep(40);
    }
  }
}

module.exports = { acquireMetadataLock };
