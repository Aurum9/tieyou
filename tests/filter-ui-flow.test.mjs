import test from 'node:test';
import assert from 'node:assert/strict';
import { initSearchFilters } from '../web/lib/filter-ui.js';

// Small DOM fixture: exercise the real handlers and generated query as one flow.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.events = {}; this.dataset = {}; this.value = ''; this.validity = { badInput: false }; this.classList = { toggle() {} }; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = value; if (key === 'value') this.value = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  dispatch(name) { for (const handler of this.events[name] || []) handler({ target: this }); }
  cloneNode() { const clone = new Element(this.tagName); for (const [key, value] of Object.entries(this.attributes)) clone.setAttribute(key, value); clone.textContent = this._text; return clone; }
  removeAttribute(key) { delete this.attributes[key]; }
  focus() { document.activeElement = this; this.dispatch('focus'); }
}
const all = (root, predicate) => root.children.flatMap(child => [...(predicate(child) ? [child] : []), ...all(child, predicate)]);
function fixture() {
  const ids = new Map(); const body = new Element('body');
  const get = id => { if (!ids.has(id)) { const element = new Element(); element.id = id; ids.set(id, element); body.append(element); } return ids.get(id); };
  globalThis.document = {
    body, createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; }, createDocumentFragment: () => new Element('fragment'),
    getElementById: id => ids.get(id) || all(body, node => node.id === id)[0],
    querySelector: selector => get(selector.slice(1)),
    querySelectorAll(selector) {
      if (selector === '[data-tag]') return all(body, node => Object.hasOwn(node.dataset, 'tag'));
      const [id, child] = selector.split(' '); const root = get(id.slice(1));
      return all(root, node => node.tagName === child.split(':')[0] && (!child.endsWith(':checked') || node.checked));
    },
  };
  for (const color of ['W', 'U', 'B', 'R', 'G', 'C']) { const button = new Element('button'); button.setAttribute('data-color', color); get('color-filters').append(button); }
  const changes = []; const ui = initSearchFilters({ onChange: () => changes.push(ui.getSearch()) });
  return { ui, get, changes };
}
const inputs = (get, id) => all(get(id), node => node.attributes.role === 'combobox');
function enter(input, value) { input.value = value; input.dispatch('input'); }

test('category and tag rows add a blank row and support exclusions and partial matching', () => {
  const { ui, get } = fixture();
  enter(inputs(get, 'type-conditions')[0], '传奇');
  enter(inputs(get, 'type-conditions')[1], '妖精');
  assert.equal(inputs(get, 'type-conditions').length, 3);
  const matches = all(get('type-conditions'), node => node.tagName === 'label')[0];
  assert.equal(matches.hidden, false);
  matches.children[0].checked = true;
  matches.children[0].dispatch('change');
  enter(inputs(get, 'tag-conditions')[0], '抓牌');
  enter(inputs(get, 'tag-conditions')[1], 'treasure');
  all(get('tag-conditions'), node => node.tagName === 'button')[1].dispatch('click');
  assert.match(ui.getSearch().displayQuery, /t:"传奇" OR t:"妖精"/);
  assert.match(ui.getSearch().displayQuery, /tag:"抓牌" AND NOT \(tag:"treasure"\)/);
});

test('direct fields and selected mana values are serialized into the search box', () => {
  const { ui, get, changes } = fixture();
  enter(get('card-name-filter'), '莉莲娜');
  enter(get('oracle-filter'), '抓一张牌');
  enter(get('artist-filter'), 'Rebecca Guay');
  enter(get('mana-cost-filter'), '{2}{G}{G}');
  for (const label of get('mana-values').children) {
    if (['0','2','9'].includes(label.children[0].value)) label.children[0].checked = true;
  }
  assert.equal(changes.length, 4);
  const current = ui.getSearch();
  for (const clause of ['name:"莉莲娜"', 'o:"抓一张牌"', 'a:"Rebecca Guay"', 'm="{2}{G}{G}"', '(mv=0 OR mv=2 OR mv>=9)']) {
    assert.ok(current.displayQuery.includes(clause), clause);
  }
  assert.equal(current.error, null);
  ui.clear({ silent: true });
  assert.equal(ui.getSearch().displayQuery, '');
  assert.equal(changes.length, 4);
});

test('commander scope hides and pauses manual identity until switched off', () => {
  const { ui, get } = fixture();
  ui.setCommanderScope(['B'], false);
  get('identity-filters').children.find(node => node.dataset.color === 'U').dispatch('click');
  assert.equal(ui.getSearch().displayQuery, 'ci<=u');
  ui.setCommanderScope(['B'], true);
  assert.equal(get('identity-controls').hidden, true);
  assert.equal(ui.getSearch().displayQuery, '');
  ui.setCommanderScope(['B'], false);
  assert.equal(get('identity-controls').hidden, false);
  assert.equal(ui.getSearch().displayQuery, 'ci<=u');
  ui.setCommanderScope(null, true);
  assert.equal(get('catalog-scope-label').hidden, true);
  assert.equal(get('identity-controls').hidden, false);
});

test('typed subtype suggestions show the parent type and serialize the canonical term', () => {
  const { ui, get } = fixture();
  ui.setMetadata({ typeVocabulary: [{ value: 'Elf', label: '妖精', detail: '生物副类别' }] });
  const input = inputs(get, 'type-conditions')[0];
  input.focus();
  enter(input, 'elf');
  const option = all(get('type-conditions'), node => node.attributes.role === 'option')[0];
  assert.match(option.textContent, /妖精生物副类别/);
  option.dispatch('click');
  assert.match(ui.getSearch().displayQuery, /t:"Elf"/);
});

test('range errors can still be corrected by removing the matching filter', () => {
  const { ui, get } = fixture();
  enter(get('power-min'), '4');
  enter(get('power-max'), '2');
  assert.match(ui.getSearch().error, /力量下限/);
  ui.renderActiveFilters();
  get('active-filters').children.find(node => node.textContent.includes('力量 ≥')).dispatch('click');
  assert.equal(get('power-min').value, '');
  assert.equal(ui.getSearch().error, null);
});
