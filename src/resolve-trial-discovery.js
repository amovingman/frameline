'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { describeRenameTrial, validatePrivateTrialDirectory } = require('./resolve-rename-trial');
const { inspectRenameTrialHistoryLink } = require('./resolve-trial-history');

const NAME = /^rename-\d{13}-([a-f0-9]{32})$/;
const PAGE_SIZE = 20;

async function discoverRenameTrials({ directory, store, cursor = null } = {}) {
  if (cursor !== null && !NAME.test(cursor)) throw new Error('invalid-discovery-cursor');
  try { await validatePrivateTrialDirectory(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { items: [], selections: new Map(), scanned: 0, total: 0, hasMore: false, cursor: null };
    throw error;
  }
  const candidates = [];
  const iterator = await fs.opendir(directory);
  let count = 0;
  for await (const entry of iterator) {
    if (++count > 5000) throw new Error('trial-discovery-limit');
    if (NAME.test(entry.name)) candidates.push(entry);
  }
  candidates.sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
  const remaining = candidates.filter(entry => cursor === null || entry.name < cursor);
  const page = remaining.slice(0, PAGE_SIZE), items = [], selections = new Map();
  for (const entry of page) {
    const selected = path.join(directory, entry.name);
    const recordId = createHash('sha256').update(entry.name).digest('hex');
    const fallback = { recordId, transactionId: NAME.exec(entry.name)[1], projectName: null,
      createdAt: null, state: 'unreadable', action: 'none' };
    let canReveal = false;
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('invalid-trial-directory');
      await validatePrivateTrialDirectory(selected); canReveal = true;
      const descriptor = await describeRenameTrial(selected);
      if (descriptor.transactionId !== fallback.transactionId) throw new Error('trial-directory-id-mismatch');
      if (descriptor.state === 'cancelled') continue;
      if (descriptor.state === 'outcome' && await inspectRenameTrialHistoryLink({ directory: selected, store,
        result: descriptor.result, snapshot: descriptor.snapshot, target: descriptor.target })) continue;
      const item = { ...fallback, projectName: descriptor.projectName, createdAt: descriptor.createdAt,
        state: descriptor.state, action: ['unfinished', 'outcome'].includes(descriptor.state) ? 'recover'
          : descriptor.state === 'prepared' ? 'cancel' : 'reveal' };
      items.push(item); selections.set(recordId, { directory: selected, action: item.action });
    } catch {
      const item = { ...fallback, action: canReveal ? 'reveal' : 'none' };
      items.push(item); selections.set(recordId, { directory: selected, action: item.action });
    }
  }
  return { items, selections, scanned: page.length, total: candidates.length,
    hasMore: remaining.length > page.length, cursor: page.at(-1)?.name || cursor };
}

module.exports = { discoverRenameTrials };
