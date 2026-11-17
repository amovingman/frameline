const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function fail(code) { const error = new Error(code); error.code = code; return error; }
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

function validateAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
    || !ID.test(anchor.timelineId || '')) throw fail('comment-anchor-invalid');
  if (anchor.kind === 'clip' && Object.keys(anchor).sort().join(',') === 'clipId,kind,timelineId'
    && ID.test(anchor.clipId || '')) return structuredClone(anchor);
  if (anchor.kind === 'range' && Object.keys(anchor).sort().join(',') === 'endFrame,kind,startFrame,timelineId'
    && Number.isSafeInteger(anchor.startFrame) && anchor.startFrame >= 0
    && Number.isSafeInteger(anchor.endFrame) && anchor.endFrame > anchor.startFrame) return structuredClone(anchor);
  throw fail('comment-anchor-invalid');
}

// Comments bind to one immutable revision. The caller must prove that the
// adapter's exact revision contains the anchor; no position/name matching.
function createReviewComments({ directory, authorize, verifyAnchor } = {}) {
  if (!path.isAbsolute(directory || '') || typeof authorize !== 'function'
    || typeof verifyAnchor !== 'function') throw fail('comment-store-invalid');
  const filename = path.join(directory, 'review-comments.json');
  let serial = Promise.resolve();
  const locked = action => { const next = serial.then(action); serial = next.catch(() => {}); return next; };
  async function read() {
    try {
      const bytes = await fs.readFile(filename);
      if (bytes.length > 10 * 1024 * 1024) throw fail('comment-store-corrupt');
      const state = JSON.parse(bytes.toString('utf8'));
      if (state.version !== 1 || !Array.isArray(state.comments) || state.comments.some(comment => {
        try {
          return !ID.test(comment?.id || '') || !ID.test(comment.projectId || '')
            || !ID.test(comment.revisionId || '') || !ID.test(comment.authorId || '')
            || !['open', 'resolved'].includes(comment.status)
            || typeof comment.body !== 'string' || !comment.body.trim() || comment.body.length > 1000
            || typeof comment.createdAt !== 'string' || !Number.isFinite(Date.parse(comment.createdAt))
            || (comment.status === 'resolved' && !Number.isFinite(Date.parse(comment.resolvedAt)))
            || !validateAnchor(comment.anchor);
        } catch { return true; }
      })) throw fail('comment-store-corrupt');
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, comments: [] };
      throw fail('comment-store-corrupt');
    }
  }
  async function write(state) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async function add({ actorId, projectId, revisionId, anchor, body }) {
    if (!ID.test(actorId || '') || !ID.test(projectId || '') || !ID.test(revisionId || '')
      || typeof body !== 'string' || !body.trim() || body.trim().length > 1000) throw fail('comment-invalid');
    const checkedAnchor = validateAnchor(anchor);
    if (authorize(actorId, projectId, 'comment') !== true) throw fail('comment-forbidden');
    if (await verifyAnchor(projectId, revisionId, checkedAnchor) !== true) throw fail('comment-anchor-unverified');
    return locked(async () => {
      const state = await read();
      const comment = { id: randomUUID(), projectId, revisionId, authorId: actorId,
        anchor: checkedAnchor, body: body.trim(), status: 'open', createdAt: new Date().toISOString() };
      state.comments.push(comment); await write(state); return structuredClone(comment);
    });
  }
  async function list({ actorId, projectId, revisionId }) {
    if (!ID.test(actorId || '') || !ID.test(projectId || '') || !ID.test(revisionId || '')) throw fail('comment-invalid');
    if (authorize(actorId, projectId, 'read') !== true) throw fail('comment-forbidden');
    return (await read()).comments.filter(item => item.projectId === projectId && item.revisionId === revisionId)
      .map(item => structuredClone(item));
  }
  async function resolve({ actorId, projectId, commentId }) {
    if (!ID.test(actorId || '') || !ID.test(projectId || '') || !ID.test(commentId || '')) throw fail('comment-invalid');
    if (authorize(actorId, projectId, 'read') !== true) throw fail('comment-forbidden');
    return locked(async () => {
      const state = await read(); const comment = state.comments.find(item => item.id === commentId && item.projectId === projectId);
      if (!comment) throw fail('comment-not-found');
      if (comment.authorId !== actorId && authorize(actorId, projectId, 'manage-comments') !== true) throw fail('comment-forbidden');
      if (comment.status !== 'resolved') { comment.status = 'resolved'; comment.resolvedAt = new Date().toISOString(); await write(state); }
      return structuredClone(comment);
    });
  }
  return { add, list, resolve };
}

module.exports = { createReviewComments, validateAnchor };
