'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createWindowedList } = require('../src/windowed-list');
const accessibility = fs.readFileSync(require.resolve('../src/accessibility'), 'utf8');

class Element {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = ''; this.scrollTop = 0; this.clientHeight = 448;
    const classes = new Set(); this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  prepend(node) { node.parentElement = this; this.children.unshift(node); }
  replaceChildren(...nodes) { this.children.forEach(node => node.parentElement = null); this.children = []; this.append(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  matches(selector) {
    if (selector === '[hidden]') return !!this.hidden;
    const role = /^\[role="([^"]+)"\]$/.exec(selector); if (role) return this.getAttribute('role') === role[1];
    if (selector === '[data-scan-position]') return this.dataset.scanPosition !== undefined;
    if (/^\.[\w-]+$/.test(selector)) return this.classList.contains(selector.slice(1)) || (this.className || '').split(' ').includes(selector.slice(1));
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').some(part => child.matches(part)) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  focus() { this.ownerDocument.activeElement = this; this.ownerDocument.emit('focusin', this); }
  setCustomValidity() {}
  reportValidity() {}
}
function fixture() {
  const document = { defaultView: {}, listeners: {}, addEventListener(name, listener, capture) { (this.listeners[name] ||= []).push({ listener, capture }); } };
  document.createElement = tag => new Element(document, tag); document.body = document.createElement('body'); document.activeElement = document.body;
  document.getElementById = id => { const find = node => node.id === id ? node : node.children.map(find).find(Boolean); return find(document.body) || null; };
  document.querySelectorAll = selector => document.body.querySelectorAll(selector); document.querySelector = selector => document.body.querySelector(selector);
  document.emit = (type, target, extra = {}) => {
    const event = { target, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    for (const item of document.listeners[type] || []) if (item.capture && !event.stopped) item.listener(event);
    for (let node = target; node && !event.stopped; node = node.parentElement) for (const listener of node.listeners[type] || []) listener(event);
    for (const item of document.listeners[type] || []) if (!item.capture && !event.stopped) item.listener(event);
    return event;
  };
  const main = document.createElement('main'), viewport = document.createElement('div'); viewport.id = 'video-track';
  document.body.append(main); main.append(viewport);
  const searchInput = document.createElement('input'), jumpInput = document.createElement('input'), jumpButton = document.createElement('button'), range = document.createElement('p');
  main.append(searchInput, jumpInput, jumpButton, range);
  let observerCallback; const window = {};
  vm.runInNewContext(accessibility, { document, window, queueMicrotask, MutationObserver: class {
    constructor(callback) { observerCallback = callback; } observe() {}
  } });
  return { document, viewport, window, searchInput, jumpInput, jumpButton, range,
    mutation: async () => { observerCallback([{ target: viewport }]); await new Promise(resolve => queueMicrotask(resolve)); } };
}

test('actual accessibility mutation handling preserves virtual scan list semantics and all-row keyboard navigation', async () => {
  const f = fixture();
  const list = createWindowedList({ ...f, renderRow: item => { const row = f.document.createElement('div'); row.textContent = item.name; return row; },
    searchText: item => item.name });
  f.viewport.setAttribute('aria-label', 'Scanned top level picture clips'); f.viewport.setAttribute('aria-describedby', 'scan-clips-help');
  list.setItems(Array.from({ length: 10001 }, (_, index) => ({ name: `Picture ${index + 1}` })), 'verified-source');
  f.viewport.focus(); const key = f.document.emit('keydown', f.viewport, { key: 'End' });
  assert.equal(key.defaultPrevented, true); assert.notEqual(key.stopped, true);
  await f.mutation();
  assert.equal(f.viewport.getAttribute('role'), 'listbox'); assert.equal(f.viewport.getAttribute('aria-label'), 'Scanned top level picture clips');
  assert.equal(f.viewport.getAttribute('aria-describedby'), 'scan-clips-help');
  assert.equal(f.viewport.getAttribute('aria-activedescendant'), 'video-track-row-10000'); assert.equal(f.document.activeElement, f.viewport);
  const option = f.viewport.querySelectorAll('[role="option"]').find(node => node.getAttribute('aria-selected') === 'true');
  assert.equal(option.getAttribute('aria-posinset'), '10001'); assert.equal(option.getAttribute('aria-setsize'), '10001');
  assert.ok(f.viewport.querySelectorAll('[role="option"]').length <= 12);
  f.document.emit('keydown', f.viewport, { key: 'Home' }); await f.mutation();
  assert.equal(f.viewport.getAttribute('aria-activedescendant'), 'video-track-row-0'); assert.equal(f.document.activeElement, f.viewport);
});
test('legacy sample button groups still retain roving focus, descriptions and keyboard activation guidance', async () => {
  const f = fixture();
  const first = f.document.createElement('button'), second = f.document.createElement('button');
  first.textContent = 'Opening'; second.textContent = 'Closing'; first.dataset.clipId = 'opening'; second.dataset.clipId = 'closing';
  f.viewport.append(first, second); await f.mutation();
  assert.equal(f.viewport.getAttribute('role'), 'group'); assert.equal(f.viewport.getAttribute('aria-describedby'), 'accessibility-queue-help');
  assert.equal(first.tabIndex, 0); assert.equal(second.tabIndex, -1); first.focus();
  const key = f.document.emit('keydown', first, { key: 'ArrowRight' });
  assert.equal(key.defaultPrevented, true); assert.equal(key.stopped, true); assert.equal(f.document.activeElement, second);
  assert.equal(first.tabIndex, -1); assert.equal(second.tabIndex, 0);
  assert.match(f.document.getElementById('accessibility-status').textContent, /Closing.*Item 2 of 2/);
});
