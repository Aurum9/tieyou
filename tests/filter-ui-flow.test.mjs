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
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'id') this.id = value; if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  dispatch(name) { for (const handler of this.events[name] || []) handler({ target: this }); }
  cloneNode() { const clone = new Element(this.tagName); for (const [key, value] of Object.entries(this.attributes)) clone.setAttribute(key, value); clone.textContent = this._text; return clone; }
  focus() {}
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
  for (const [id, values] of [['type-filters', ['Creature', 'Artifact']], ['supertype-filters', ['Basic', 'Legendary']]]) for (const value of values) { const input = new Element('input'); input.value = value; get(id).append(input); }
  const tag = new Element('button'); tag.setAttribute('data-tag', '抓牌'); body.append(tag);
  const changes = []; const ui = initSearchFilters({ onChange: () => changes.push(ui.getSearch()) });
  return { ui, get, changes, tag };
}

test('filter handlers put every selected criterion into the shared query immediately', () => {
  const { ui, get, changes, tag } = fixture();
  assert.equal(ui.getSearch().query, 'f:commander'); assert.equal(ui.getSearch().hasUserConditions, false);
  assert.equal(ui.getSearch().displayQuery, '');
  get('color-filters').children.find(node => node.dataset.color === 'G').dispatch('click');
  const legendary = get('supertype-filters').children.find(node => node.value === 'Legendary'); legendary.checked = true; legendary.dispatch('change');
  get('subtype-filter').value = '妖精'; get('subtype-filter').dispatch('input');
  get('power-min').value = '-1'; get('power-min').dispatch('input');
  get('toughness-max').value = '3'; get('toughness-max').dispatch('input');
  get('translation-filter').value = 'translated'; get('translation-filter').dispatch('change');
  tag.dispatch('click');
  const state = ui.getSearch();
  assert.equal(state.query, '(c:g) AND (t:"legendary") AND t:"妖精" AND pow>=-1 AND tou<=3 AND f:commander AND is:translated AND (tag:抓牌)');
  assert.equal(state.displayQuery, '(c:g) AND (t:"legendary") AND t:"妖精" AND pow>=-1 AND tou<=3 AND is:translated AND (tag:抓牌)');
  assert.equal(state.error, null); assert.equal(state.hasUserConditions, true); assert.equal(changes.length, 7);
  assert.equal(get('generated-query').textContent, state.query);
  ui.setMode('advanced'); ui.setMode('simple'); assert.equal(ui.getSearch().query, state.query);
  assert.equal(get('advanced-retained').hidden, false);
});

test('automatic Commander legality stays in the controls and full preview while display query keeps identity', () => {
  const { ui, get, changes } = fixture();
  for (const color of ['U', 'B']) get('identity-filters').children.find(node => node.dataset.color === color).dispatch('click');
  let state = ui.getSearch();
  assert.equal(state.query, 'ci<=ub AND f:commander');
  assert.equal(state.displayQuery, 'ci<=ub');
  assert.equal(state.filters.commanderOnly, true);
  assert.equal(state.hasUserConditions, true);
  assert.equal(get('generated-query').textContent, state.query);
  ui.renderActiveFilters();
  assert.ok(get('active-filters').children.some(node => node.textContent.includes('EDH 合法')));

  get('commander-filter').checked = false; get('commander-filter').dispatch('change');
  state = ui.getSearch();
  assert.equal(state.query, 'ci<=ub');
  assert.equal(state.displayQuery, 'ci<=ub');
  assert.equal(state.filters.commanderOnly, false);
  assert.equal(get('generated-query').textContent, state.query);
  ui.renderActiveFilters();
  assert.equal(get('active-filters').children.some(node => node.textContent.includes('EDH 合法')), false);

  get('commander-filter').checked = true; get('commander-filter').dispatch('change');
  ui.renderActiveFilters();
  get('active-filters').children.find(node => node.textContent.includes('EDH 合法')).dispatch('click');
  assert.equal(ui.getSearch().filters.commanderOnly, false);
  assert.equal(get('commander-filter').checked, false);
  assert.equal(ui.getSearch().displayQuery, 'ci<=ub');
  assert.equal(changes.length, 5);
});

test('explicit legality rules in the condition builder remain visible in the display query', () => {
  const { ui, get } = fixture();
  const builder = get('condition-builder');
  all(builder, node => node.tagName === 'button' && node.textContent === '＋ 条件')[0].dispatch('click');
  let field = all(builder, node => node.attributes['aria-label'] === '条件字段')[0];
  field.value = 'f'; field.dispatch('change');
  const value = all(builder, node => node.attributes['aria-label'] === '赛制合法性条件值')[0];
  value.value = 'commander'; value.dispatch('change');
  assert.equal(ui.getSearch().query, 'f:commander AND (f:"commander")');
  assert.equal(ui.getSearch().displayQuery, '(f:"commander")');
  assert.equal(ui.getSearch().hasUserConditions, true);
  get('commander-filter').checked = false; get('commander-filter').dispatch('change');
  assert.equal(ui.getSearch().query, '(f:"commander")');
  assert.equal(ui.getSearch().displayQuery, '(f:"commander")');
});

test('silent clear relinquishes control without emitting a second search or keeping hidden conditions', () => {
  const { ui, get, changes } = fixture();
  get('mana-min').value = '0'; get('mana-min').dispatch('input');
  assert.equal(ui.getSearch().hasUserConditions, true);
  ui.clear({ silent: true });
  assert.equal(changes.length, 1); assert.equal(ui.getSearch().query, ''); assert.equal(ui.getSearch().hasUserConditions, false);
  assert.equal(ui.getSearch().displayQuery, '');
  assert.equal(get('commander-filter').checked, false); assert.equal(get('mana-min').value, '');
  ui.reset(); assert.equal(ui.getSearch().query, 'f:commander'); assert.equal(ui.getSearch().displayQuery, ''); assert.equal(changes.length, 2);
});

test('range errors remain visible before searching and removing their filter clears the input', () => {
  const { ui, get } = fixture();
  get('power-min').value = '4'; get('power-min').dispatch('input');
  get('power-max').value = '2'; get('power-max').dispatch('input');
  assert.match(ui.getSearch().error, /力量下限/);
  assert.equal(ui.getSearch().hasUserConditions, true);
  assert.equal(ui.getSearch().displayQuery, 'pow>=4 AND pow<=2');
  ui.renderActiveFilters();
  get('active-filters').children.find(node => node.textContent.includes('力量 ≥')).dispatch('click');
  assert.equal(get('power-min').value, ''); assert.equal(ui.getSearch().error, null);
  get('toughness-min').validity.badInput = true;
  assert.match(ui.getSearch().error, /力量与防御力需要填写数字/);
});

test('catalog supplies Chinese and English subtype suggestions without fetching card data itself', () => {
  const { ui } = fixture();
  ui.setCatalog([
    { typeLine: 'Legendary Creature — Elf Druid', zhTypeLine: '传奇生物～妖精 德鲁伊', versions: [{ set: 'neo', setName: '神河：霓朝纪' }] },
    { typeLine: 'Creature — Time Lord Doctor', zhTypeLine: '生物～时间领主 博士', versions: [] },
    { faces: [{ typeLine: 'Artifact — Equipment', zhTypeLine: '神器～武具' }], versions: [] },
  ]);
  const datalist = all(document.body, node => node.id === 'subtype-vocabulary')[0];
  const values = all(datalist, node => node.tagName === 'option').map(node => node.attributes.value);
  for (const expected of ['Elf', 'Druid', '妖精', '德鲁伊', 'Time Lord', 'Doctor', '武具']) assert.ok(values.includes(expected), expected);
  assert.equal(values.includes('Legendary'), false); assert.equal(values.includes('Creature'), false);
});
