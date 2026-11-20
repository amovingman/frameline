'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWindowedList, visibleRange } = require('../src/windowed-list');

class Element {
  constructor(document, tag = 'div') {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.parent = null;
    this.attributes = {}; this.dataset = {}; this.style = {}; this.listeners = {}; this.value = '';
    this.scrollTop = 0; this.clientHeight = 448;
    const classes = new Set(); this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() { this.ownerDocument.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  closest(selector) { return selector === '[data-scan-position]' && this.dataset.scanPosition !== undefined ? this : this.parent?.closest(selector); }
  setCustomValidity(value) { this.validation = value; }
  reportValidity() { this.validityReported = true; }
}
function fixture(total = 20001) {
  const document = { activeElement: null, defaultView: {}, createElement: tag => new Element(document, tag) };
  const element = () => new Element(document), viewport = element(), searchInput = element(), jumpInput = element(), jumpButton = element(), range = element();
  viewport.id = 'scan-test'; let selected;
  const items = Array.from({ length: total }, (_, index) => ({ name: `Take ${String(index + 1).padStart(6, '0')}`, frame: index * 1001 }));
  const controller = createWindowedList({ viewport, searchInput, jumpInput, jumpButton, range,
    renderRow: item => { const row = element(); row.textContent = item.name; return row; },
    searchText: item => `${item.name} ${item.frame}`, onSelect: (item, index) => { selected = { item, index }; } });
  controller.setItems(items, 'project-a:source-a');
  const options = () => viewport.children[0]?.children.filter(row => row.getAttribute('role') === 'option') || [];
  const press = key => { let prevented = false; viewport.listeners.keydown({ key, preventDefault: () => prevented = true }); return prevented; };
  return { controller, document, viewport, searchInput, jumpInput, jumpButton, range, items, options, press, get selected() { return selected; } };
}

test('more than 20,000 scanned rows use a bounded DOM while End/Home and paging reach the complete data', () => {
  const f = fixture(); assert.ok(f.options().length <= 12);
  f.viewport.focus(); assert.equal(f.press('End'), true);
  assert.equal(f.selected.index, 20000); assert.equal(f.document.activeElement, f.viewport);
  assert.equal(f.viewport.getAttribute('aria-activedescendant'), 'scan-test-row-20000');
  assert.ok(f.options().some(row => row.dataset.scanIndex === '20000'));
  assert.equal(f.options().at(-1).getAttribute('aria-setsize'), '20001');
  assert.equal(f.options().at(-1).getAttribute('aria-posinset'), '20001');
  assert.ok(f.options().length <= 12); f.press('Home'); assert.equal(f.selected.index, 0);
  f.press('PageDown'); assert.equal(f.selected.index, 4); f.press('ArrowDown'); assert.equal(f.selected.index, 5);
  f.press('PageUp'); assert.equal(f.selected.index, 1); f.press('ArrowUp'); assert.equal(f.selected.index, 0);
});
test('search considers every row and jumping by original number clears a conflicting filter', () => {
  const f = fixture(); f.searchInput.value = 'take 019999'; f.searchInput.listeners.input();
  assert.equal(f.options().length, 1); assert.equal(f.selected.index, 19998);
  assert.equal(f.options()[0].getAttribute('aria-setsize'), '1'); assert.match(f.range.textContent, /1 matches.*20,001 total/);
  f.jumpInput.value = '20001'; f.jumpButton.listeners.click();
  assert.equal(f.searchInput.value, ''); assert.equal(f.selected.index, 20000); assert.equal(f.document.activeElement, f.viewport);
  assert.ok(f.options().length <= 12);
});
test('invalid jumps preserve selection and expose an actionable validation error', () => {
  const f = fixture(12);
  for (const value of ['', '0', '13', '1.5']) { f.jumpInput.value = value; f.jumpButton.listeners.click(); assert.equal(f.selected.index, 0); assert.match(f.jumpInput.validation, /1 to 12/); }
  f.jumpInput.value = '12'; f.jumpButton.listeners.click(); assert.equal(f.selected.index, 11); assert.equal(f.jumpInput.validation, '');
});
test('pointer scrolling retains a mounted active option and the persistent keyboard focus', () => {
  const f = fixture(); f.viewport.focus(); f.viewport.scrollTop = 10000 * 112; f.viewport.listeners.scroll();
  assert.equal(f.document.activeElement, f.viewport);
  assert.ok(f.options().some(row => row.id === f.viewport.getAttribute('aria-activedescendant')));
  assert.ok(f.options().length <= 12);
  const middle = f.options().find(row => row.dataset.scanIndex === '10000');
  f.viewport.listeners.click({ target: middle }); assert.equal(f.selected.index, 10000);
  assert.equal(f.document.activeElement, f.viewport);
});
test('refreshing the same source keeps query and chosen row; another source resets both', () => {
  const f = fixture(); f.searchInput.value = 'Take 019'; f.searchInput.listeners.input(); f.press('End'); const previous = f.selected.index;
  f.controller.setItems(f.items.map(item => ({ ...item })), 'project-a:source-a');
  assert.equal(f.searchInput.value, 'Take 019'); assert.equal(f.selected.index, previous);
  f.controller.setItems(f.items, 'project-a:source-b'); assert.equal(f.searchInput.value, ''); assert.equal(f.selected.index, 0); assert.equal(f.viewport.scrollTop, 0);
});
test('empty and zero-match lists retain honest counts without dangling accessible descendants', () => {
  const f = fixture(0); assert.equal(f.range.textContent, '0 rows'); assert.equal(f.jumpButton.disabled, true);
  assert.equal(f.viewport.getAttribute('aria-activedescendant'), null);
  f.controller.setItems([{ name: 'Available take', frame: 0 }], 'source-b'); f.searchInput.value = 'absent'; f.searchInput.listeners.input();
  assert.equal(f.options().length, 0); assert.equal(f.viewport.getAttribute('aria-activedescendant'), null); assert.equal(f.selected.index, -1);
  assert.match(f.range.textContent, /0 matches of 1 rows/);
  f.searchInput.value = ''; f.searchInput.listeners.input(); assert.equal(f.selected.index, 0);
});
test('clearing scan mode cannot let resize or scroll callbacks overwrite another view', () => {
  const f = fixture(); f.controller.clear(); f.viewport.append(new Element(f.document));
  f.viewport.listeners.scroll(); f.controller.refresh(); assert.equal(f.viewport.children.length, 1);
  assert.equal(f.viewport.classList.contains('scan-window-list'), false); assert.equal(f.viewport.getAttribute('role'), null);
});
test('window bounds stay valid after a shorter filtered list replaces a distant viewport', () => {
  assert.deepEqual(visibleRange(3, 100000, 448, 112), { start: 3, end: 3, beforePx: 336, afterPx: 0 });
  const f = fixture(); f.press('End'); f.searchInput.value = 'Take 000001'; f.searchInput.listeners.input();
  assert.equal(f.viewport.scrollTop, 0); assert.equal(f.options().length, 1); assert.equal(f.selected.index, 0);
});
