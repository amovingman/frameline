'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/media-jobs-renderer.js'), 'utf8');
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
async function fixture() {
  const nodes = new Map(), el = key => { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); };
  const job = { id: 'job-1', kind: 'thumbnail', status: 'completed', progress: 100, attempts: 1,
    processingMs: 20, createdAt: '2026-11-19T12:00:00.000Z', error: null,
    result: { mimeType: 'image/png', byteLength: 500, sha256: 'a'.repeat(64), canonical: false } };
  const lookup = key => key === 'media-jobs-preview' ? el('media-jobs-preview-slot').children.find(node => node.id === key) || null : el(key);
  const state = { projectId: 'film', sourceHash: 'b'.repeat(64), available: true, renderingAvailable: true,
    source: { id: 'source-1', name: '<script>media</script>.png' }, policy: { enabled: true, rightsConfirmed: true, costPerGiBMonthUSD: null },
    jobs: [job], metrics: { counts: { completed: 1 }, backlog: 0, failures: 0, processingMs: 20, cacheBytes: 500, estimatedMonthlyStorageCostUSD: null } };
  let listener, resolve;
  const desktop = { getMediaJobsState: async () => structuredClone(state), onMediaJobsState: callback => listener = callback,
    previewMediaJob: () => new Promise(done => resolve = done) };
  el('media-jobs-kind').value = 'thumbnail';
  vm.runInNewContext(source, { document: { getElementById: lookup, createElement: tag => new Element(tag), activeElement: null }, window: { desktop }, Date });
  await settle();
  return { state, job, el: key => lookup(`media-jobs-${key}`), emit() { listener(structuredClone(state)); },
    preview() { const target = { dataset: { mediaAction: 'preview' }, closest: () => ({ dataset: { jobId: job.id } }) };
      return el('media-jobs-list').listeners.click({ target: { closest: () => target } }); },
    release() { resolve({ dataUrl: 'data:image/png;base64,AA==', canonical: false }); } };
}
test('a preview response arriving after project, source, consent or result changes cannot reopen the preview', async () => {
  for (const change of [f => f.state.projectId = 'other-film', f => f.state.source.id = 'source-2',
    f => f.state.policy.rightsConfirmed = false, f => f.job.result.sha256 = 'c'.repeat(64)]) {
    const f = await fixture(); const pending = f.preview(); await settle(); change(f); f.emit(); f.release(); await pending;
    assert.equal(f.el('preview')?.src, undefined); assert.equal(f.el('preview-figure').hidden, true);
  }
});
test('current verified preview displays, and closing during a pending response keeps it closed', async () => {
  const f = await fixture(); const pending = f.preview(); await settle(); f.release(); await pending;
  assert.equal(f.el('preview')?.src, 'data:image/png;base64,AA=='); assert.equal(f.el('preview-figure').hidden, false);
  const next = f.preview(); await settle(); f.el('preview-close').listeners.click(); f.release(); await next;
  assert.equal(f.el('preview')?.src, undefined); assert.equal(f.el('preview-figure').hidden, true);
});
test('history stays bounded and tiny known costs do not appear as zero', async () => {
  const f = await fixture(); f.state.jobs = Array.from({ length: 25 }, (_, i) => ({ ...f.job, id: `job-${i}`, createdAt: new Date(Date.UTC(2026, 10, 19, 0, 0, i)).toISOString() }));
  f.state.metrics.estimatedMonthlyStorageCostUSD = 0.00000001; f.emit();
  assert.equal(f.el('list').children.length, 20); assert.equal(f.el('list').children[0].dataset.jobId, 'job-24');
  assert.match(f.el('metrics').textContent, /<\$0\.0001 USD/); assert.equal(f.el('source-name').textContent, '<script>media</script>.png');
  f.el('next').listeners.click(); assert.equal(f.el('list').children.length, 5);
});
