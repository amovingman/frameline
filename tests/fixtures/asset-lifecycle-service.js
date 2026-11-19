'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { createDurableAssetService } = require('../../src/durable-asset-service');
const { createKeyring } = require('../../src/security-controls');
const { createMediaAssetIdentity } = require('../../src/media-asset-identity');
const owner = { accessToken: 'o'.repeat(43) }, editor = { accessToken: 'e'.repeat(43) }, viewer = { accessToken: 'v'.repeat(43) };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function lifecycleFixture(t, extra = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'frameline-lifecycle-'))), keyring = createKeyring({ fixture: randomBytes(32) }, 'fixture');
  let at = 1000, store; const stores = [], revoked = new Set();
  const authorize = async (context, projectId, action) => {
    if (!['film', 'other-film'].includes(projectId) || revoked.has(context.accessToken)
      || ![owner.accessToken, editor.accessToken, viewer.accessToken].includes(context.accessToken)
      || action !== 'read' && context.accessToken === viewer.accessToken) throw Object.assign(new Error('secret'), { code: 'forbidden' });
    return { allowed: true, actorId: context.accessToken === owner.accessToken ? 'owner-id' : 'member-id' };
  };
  const authorizePolicy = async context => {
    if (context.accessToken !== owner.accessToken || revoked.has(owner.accessToken)) throw Object.assign(new Error('secret'), { code: 'asset-policy-forbidden' });
    return { allowed: true, actorId: 'owner-id' };
  };
  const opts = { directory, keyring, authorize, authorizePolicy, now: () => at, chunkSize: 4, ...extra };
  async function open(changes = {}) { const instance = await createDurableAssetService({ ...opts, ...changes }); stores.push(instance); return instance; }
  store = await open({ initialize: true });
  for (const projectId of ['film', 'other-film']) await store.setPolicy(owner, projectId, { expectedVersion: 0, syncClasses: ['original', 'proxy'] });
  t.after(async () => { for (const value of stores) await value.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, keyring, opts, revoked, authorize, authorizePolicy, get store() { return store; },
    get at() { return at; }, setTime: value => at = value, advance: value => at += value, open,
    async reopen(changes = {}) { await store.close(); store = await open(changes); return store; },
    async state() { return keyring.decrypt(JSON.parse(await fs.readFile(path.join(directory, 'assets.enc.json'), 'utf8')).record); },
    async saveState(value) {
      const filename = path.join(directory, 'assets.enc.json'), wrapper = JSON.parse(await fs.readFile(filename, 'utf8'));
      wrapper.record = keyring.encrypt(value); await fs.writeFile(filename, JSON.stringify(wrapper));
    },
    async upload(text = 'media bytes', projectId = 'film', assetClass = 'original') {
      const bytes = Buffer.from(text), identity = createMediaAssetIdentity({ size: bytes.length, sha256: sha(bytes) }, { assetClass });
      const upload = await store.beginUpload(owner, projectId, identity);
      for (let i = 0; i < upload.chunks; i++) { const chunk = bytes.subarray(i * 4, i * 4 + 4); await store.putChunk(owner, projectId, upload.uploadId, i, chunk, sha(chunk)); }
      await store.completeUpload(owner, projectId, upload.uploadId); return { assetId: identity.contentId, uploadId: upload.uploadId, bytes };
    }
  };
}
const holdInput = (expectedVersion = 0, patch = {}) => ({ expectedVersion, held: true, reason: 'manual', until: null, idempotencyKey: `hold-${expectedVersion}`, ...patch });
const page = { afterAssetId: null, limit: 100 };
module.exports = { lifecycleFixture, owner, editor, viewer, holdInput, page };
