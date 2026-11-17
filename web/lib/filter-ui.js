import { CNY_PER_USD, FIVE_DH_BUDGET } from './catalog-price.js';
import { CONDITION_FIELDS, createCondition, createGroup, buildConditionQuery, buildFilterQuery } from './query-builder.js';
import { TYPE_NAMES, SUPERTYPE_NAMES } from './type-vocabulary.js';
import { normalizeText } from './search.js';
import { loadTagVocabulary, TAG_NAMES, visibleTagLabel } from './tag-vocabulary.js';

const COLOR_NAMES = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿', C: '无色' };
function el(tag, attrs = {}, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) element.setAttribute(key, String(value));
  }
  if (text !== undefined) element.textContent = text;
  return element;
}
function select(options, value, label) {
  const element = el('select', { class: 'condition-select', 'aria-label': label });
  for (const option of options) element.append(el('option', { value: option.value }, option.label));
  element.value = value;
  return element;
}
function button(text, action, className = 'text-button') {
  const element = el('button', { type: 'button', class: className }, text);
  element.addEventListener('click', action);
  return element;
}
function toggleColor(selected, color) {
  if (selected.includes(color)) return selected.filter(value => value !== color);
  return color === 'C' ? ['C'] : [...selected.filter(value => value !== 'C'), color];
}
const directFields = [
  ['#card-name-filter', 'name', ':'], ['#oracle-filter', 'o', ':'],
  ['#mana-cost-filter', 'm', '='], ['#artist-filter', 'a', ':'], ['#set-filter', 'set', ':'],
];
const bounds = [['#power-min', 'minPower'], ['#power-max', 'maxPower'],
  ['#toughness-min', 'minToughness'], ['#toughness-max', 'maxToughness']];
const typeOptions = [
  ...Object.entries(TYPE_NAMES).map(([value, label]) => ({ value, label, detail: '类别' })),
  ...Object.entries(SUPERTYPE_NAMES).map(([value, label]) => ({ value, label, detail: '超类别' })),
];
const tagOptions = rows => {
  const options = new Map(Object.entries(TAG_NAMES).map(([value, label]) => [value, { value, label, detail: value }]));
  for (const tag of rows) {
    const value = tag.slug;
    const label = visibleTagLabel(value);
    if (label) options.set(value, { value, label, aliases: tag.aliases, detail: value });
  }
  return [...options.values()];
};

function createRepeatingFilter(container, label, changed, initialOptions) {
  const list = el('div', { class: 'repeat-filter-list' });
  const matchLabel = el('label', { class: 'checkbox-label repeat-match' });
  const match = el('input', { type: 'checkbox' });
  matchLabel.append(match, document.createTextNode('允许部分匹配'));
  container.append(list, matchLabel);
  match.addEventListener('change', changed);
  let options, rows = [], nextId = 0;
  const activeRows = () => rows.filter(row => row.input.value.trim());
  function updateRows() {
    if (rows.at(-1)?.input.value.trim() || !rows.length) addRow();
    matchLabel.hidden = activeRows().length < 2;
    if (matchLabel.hidden) match.checked = false;
  }
  function addRow() {
    const id = container.id + '-' + ++nextId;
    const wrap = el('div', { class: 'repeat-filter-row' });
    const input = el('input', { class: 'condition-value', role: 'combobox', type: 'text', autocomplete: 'off', 'aria-label': label, 'aria-autocomplete': 'list', 'aria-controls': id, 'aria-expanded': 'false' });
    const menu = el('div', { class: 'filter-suggestions', role: 'listbox', id, hidden: '' });
    const mode = button('属于', () => {
      row.exclude = !row.exclude;
      mode.textContent = row.exclude ? '排除' : '属于';
      mode.setAttribute('aria-pressed', String(row.exclude));
      changed();
    }, 'repeat-filter-mode');
    mode.setAttribute('aria-label', '排除' + label);
    mode.setAttribute('aria-pressed', 'false');
    mode.disabled = true;
    const row = { input, exclude: false, selection: null, suggest };
    rows.push(row);
    wrap.append(mode, input, menu);
    list.append(wrap);
    let suggestions = [], selected = -1;
    function close() {
      menu.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      selected = -1;
    }
    function selectOption(option) {
      input.value = option.label;
      row.selection = option;
      mode.disabled = false;
      close();
      updateRows();
      changed();
    }
    function suggest() {
      const needle = normalizeText(input.value);
      if (!needle || row.selection || document.activeElement !== input) { close(); return; }
      const ranked = options.flatMap(option => {
        const score = Math.min(...option.terms.map(term => term === needle ? 0 : term.startsWith(needle) ? 1 : term.includes(needle) ? 2 : Infinity));
        return Number.isFinite(score) ? [{ option, score }] : [];
      });
      suggestions = ranked.sort((left, right) => left.score - right.score).slice(0, 8).map(item => item.option);
      if (!suggestions.length) { close(); return; }
      selected = -1;
      input.removeAttribute('aria-activedescendant');
      menu.replaceChildren(...suggestions.map((option, index) => {
        const item = button('', () => selectOption(option), 'filter-suggestion');
        item.id = id + '-' + index;
        item.tabIndex = -1;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.append(el('span', {}, option.label));
        if (option.detail) item.append(el('small', {}, option.detail));
        item.addEventListener('pointerdown', event => event.preventDefault());
        return item;
      }));
      menu.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('focus', suggest);
    input.addEventListener('blur', close);
    input.addEventListener('input', () => {
      row.selection = null;
      mode.disabled = !input.value.trim();
      if (mode.disabled) {
        row.exclude = false;
        mode.textContent = '属于';
        mode.setAttribute('aria-pressed', 'false');
      }
      updateRows();
      suggest();
      changed();
    });
    input.addEventListener('keydown', event => {
      if (event.isComposing || menu.hidden) return;
      if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
      if (event.key === 'Enter' && selected >= 0) { event.preventDefault(); selectOption(suggestions[selected]); return; }
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      selected = selected < 0 ? (step === 1 ? 0 : suggestions.length - 1) : (selected + step + suggestions.length) % suggestions.length;
      Array.from(menu.children).forEach((item, index) => item.setAttribute('aria-selected', String(index === selected)));
      input.setAttribute('aria-activedescendant', menu.children[selected].id);
      menu.children[selected].scrollIntoView({ block: 'nearest' });
    });
    wrap.addEventListener('focusout', event => {
      if (wrap.contains(event.relatedTarget) || input.value.trim() || rows.at(-1) === row) return;
      rows = rows.filter(item => item !== row);
      wrap.remove();
    });
  }
  function setOptions(values) {
    options = values.map(option => ({ ...option, terms: [...new Set([option.label, option.value, ...(Array.isArray(option.aliases) ? option.aliases : [])].map(normalizeText))] }));
    for (const row of rows) if (document.activeElement === row.input) row.suggest();
  }
  function clear() {
    rows = [];
    list.replaceChildren();
    match.checked = false;
    updateRows();
  }
  setOptions(initialOptions);
  clear();
  return { clear, setOptions, count: () => activeRows().length, group(field) {
    const group = createGroup();
    group.mode = match.checked ? 'any' : 'all';
    group.children = activeRows().map(({ input, exclude, selection }) => ({
      ...createCondition(field), value: selection?.value ?? input.value, exclude,
    }));
    return group;
  } };
}

export function initSearchFilters({ onChange }) {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const defaults = () => ({ colors: [], colorRelation: 'any', identities: [], identityRelation: 'within', commanderOnly: true });
  let filters = defaults();
  let conditionRoot = createGroup();
  let vocabularyPromise;
  const datalist = el('datalist', { id: 'tag-vocabulary' });
  const setlist = el('datalist', { id: 'set-vocabulary' });
  document.body.append(datalist, setlist);
  const types = createRepeatingFilter($('#type-conditions'), '类别', changed, typeOptions);
  const tags = createRepeatingFilter($('#tag-conditions'), '功能标签', changed, tagOptions([]));
  const mana = $('#mana-values');
  for (let value = 0; value <= 9; value++) {
    const label = el('label', { class: 'mana-value-option' });
    label.append(el('input', { type: 'checkbox', value }), el('span', {}, value === 9 ? '9+' : value));
    mana.append(label);
  }
  const rarities = CONDITION_FIELDS.find(field => field.value === 'r').options.slice(0, 4);
  for (const {value, label} of rarities) {
    const item = el('label', { class: 'checkbox-label' });
    item.append(el('input', { type: 'checkbox', value }), el('span', {}, label));
    $('#rarity-filters').append(item);
  }

  const fiveDh = $('#five-dh');
  const fiveDhOverage = $('#five-dh-overage');
  const fiveDhPercent = $('#five-dh-percent');
  const fiveDhSettings = $('#five-dh-settings');
  const defaultOverage = '20';
  fiveDhSettings.title = `按固定参考汇率 1 USD ≈ ${CNY_PER_USD} CNY 估算`;

  function changed() {
    syncChoices();
    onChange();
  }
  function loadVocabulary() {
    vocabularyPromise ??= loadTagVocabulary().then(rows => {
      const options = tagOptions(rows);
      tags.setOptions(options);
      datalist.replaceChildren(...options.map(option => el('option', { value: option.value, label: option.label })));
    }).catch(() => { vocabularyPromise = null; });
    return vocabularyPromise;
  }
  function makeExclude(model, label) {
    const wrap = el('label', { class: 'condition-exclude' });
    const input = el('input', { type: 'checkbox', 'aria-label': label });
    input.checked = model.exclude;
    input.addEventListener('change', () => { model.exclude = input.checked; changed(); });
    wrap.append(input, document.createTextNode('排除'));
    return wrap;
  }
  function addRule(parent, field = 'o') {
    if (ruleCount(conditionRoot) >= 16) return;
    const rule = createCondition(field);
    parent.children.push(rule);
    renderBuilder();
    changed();
    document.getElementById('condition-value-' + rule.id)?.focus();
  }
  function ruleCount(group) { return group.children.reduce((sum, item) => sum + (item.kind === 'group' ? ruleCount(item) : 1), 0); }
  function removeChild(parent, child) {
    parent.children = parent.children.filter(item => item.id !== child.id);
    renderBuilder(); changed();
  }
  function renderRule(rule, parent) {
    const spec = CONDITION_FIELDS.find(field => field.value === rule.field);
    const wrap = el('div', { class: 'condition-rule', 'data-condition-id': rule.id });
    const header = el('div', { class: 'condition-rule-head' });
    const field = select(CONDITION_FIELDS.map(item => ({ value: item.value, label: item.label })), rule.field, '条件字段');
    field.addEventListener('change', () => { const next = createCondition(field.value); Object.assign(rule, { field: next.field, op: next.op, value: next.value }); renderBuilder(); changed(); document.getElementById('condition-value-' + rule.id)?.focus(); });
    const op = select(spec.operators, rule.op, '条件匹配方式');
    op.addEventListener('change', () => { rule.op = op.value; changed(); });
    const remove = button('×', () => { removeChild(parent, rule); }, 'condition-remove');
    remove.setAttribute('aria-label', '移除' + spec.label + '条件');
    header.append(field, op, remove); wrap.append(header);
    let value;
    if (spec.input === 'colors') {
      value = el('div', { class: 'condition-colors', role: 'group', 'aria-label': spec.label + '条件值' });
      for (const [color, name] of Object.entries(COLOR_NAMES)) {
        const pick = button(name, () => {
          rule.value = toggleColor(String(rule.value || '').split(''), color).join('');
          for (const child of value.children) child.setAttribute('aria-pressed', String(rule.value.includes(child.dataset.color)));
          changed();
        });
        pick.dataset.color = color;
        pick.setAttribute('aria-label', spec.label + '：' + name);
        pick.setAttribute('aria-pressed', String(String(rule.value).includes(color)));
        value.append(pick);
      }
    } else if (spec.input === 'select') {
      value = select([{ value: '', label: '请选择' }, ...spec.options], rule.value, spec.label + '条件值');
      value.addEventListener('change', () => { rule.value = value.value; changed(); });
    } else {
      value = el('input', { class: 'condition-value', type: spec.input === 'number' ? 'number' : 'text', 'aria-label': spec.label + '条件值', placeholder: spec.placeholder || '输入' + spec.label, autocomplete: 'off' });
      value.value = rule.value;
      if (spec.input === 'number') { if (!spec.signed) value.min = '0'; value.step = 'any'; value.inputMode = 'decimal'; }
      if (rule.field === 'tag') value.setAttribute('list', 'tag-vocabulary');
      if (rule.field === 'set') value.setAttribute('list', 'set-vocabulary');
      value.addEventListener('input', () => { rule.value = value.validity?.badInput ? '无效数字' : value.value; changed(); });
    }
    value.id = 'condition-value-' + rule.id;
    wrap.append(value);
    const foot = el('div', { class: 'condition-rule-foot' });
    foot.append(makeExclude(rule, '排除' + spec.label + '条件'));
    wrap.append(foot);
    if (spec.help) wrap.append(el('p', { class: 'condition-help' }, spec.help));
    return wrap;
  }
  function renderGroup(group, parent, depth = 0) {
    const wrap = el('div', { class: 'condition-group', role: 'group', 'aria-label': depth ? '搜索条件子组' : '搜索条件组合' });
    const header = el('div', { class: 'condition-group-header' });
    const match = select([{ value: 'all', label: '满足以下全部条件' }, { value: 'any', label: '满足以下任一条件' }], group.mode, depth ? '子组条件关系' : '条件组合关系');
    match.addEventListener('change', () => { group.mode = match.value; changed(); });
    header.append(match, makeExclude(group, depth ? '排除整个子组' : '排除整组条件'));
    if (parent) {
      const remove = button('×', () => { removeChild(parent, group); }, 'condition-remove');
      remove.setAttribute('aria-label', '移除条件子组'); header.append(remove);
    }
    wrap.append(header);
    if (!group.children.length) wrap.append(el('p', { class: 'condition-empty' }, '例如：规则包含“抓牌”，或系列为 NEO。'));
    for (const child of group.children) wrap.append(child.kind === 'group' ? renderGroup(child, group, depth + 1) : renderRule(child, group));
    const actions = el('div', { class: 'condition-actions' });
    const add = button('＋ 条件', () => addRule(group));
    add.disabled = ruleCount(conditionRoot) >= 16;
    actions.append(add);
    if (depth < 2) {
      const addGroup = button('＋ 条件组', () => { const sub = createGroup(); sub.children.push(createCondition()); group.children.push(sub); renderBuilder(); changed(); document.getElementById('condition-value-' + sub.children[0].id)?.focus(); });
      addGroup.disabled = ruleCount(conditionRoot) >= 16;
      actions.append(addGroup);
    }
    wrap.append(actions);
    return wrap;
  }
  function renderBuilder() { $('#condition-builder').replaceChildren(renderGroup(conditionRoot)); }
  function getSearch() {
    const root = createGroup();
    for (const [selector, field, op] of directFields) root.children.push({ ...createCondition(field), op, value: $(selector).value });
    const rarityGroup = createGroup();
    rarityGroup.mode = 'any';
    rarityGroup.children = $$('#rarity-filters input:checked').map(input => ({ ...createCondition('r'), value: input.value }));
    root.children.push(types.group('t'), tags.group('tag'), rarityGroup, conditionRoot);
    const advanced = buildConditionQuery(root);
    const stats = Object.fromEntries(bounds.map(([selector, key]) => [key, $(selector).value]));
    const manaValues = $$('#mana-values input:checked').map(input => Number(input.value));
    const identities = $('#identity-controls').hidden ? [] : filters.identities;
    const basic = buildFilterQuery({ ...filters, identities, ...stats, manaValues, commanderOnly: false });
    const overage = Number(fiveDhPercent.value);
    const invalidOverage = fiveDh.checked && fiveDhOverage.checked &&
      (!fiveDhPercent.value || fiveDhPercent.validity.badInput || !Number.isFinite(overage) || overage < 0);
    const limit = FIVE_DH_BUDGET + (fiveDhOverage.checked ? overage / 20 : 0);
    const budget = fiveDh.checked && !invalidOverage ? `cny<=${limit.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 })}` : '';
    const error = invalidOverage ? '请输入非负的超预算百分比。' : bounds.some(([selector]) => $(selector).validity.badInput)
      ? '力量与防御力需要填写数字，留空表示不限。' : basic.error || advanced.error;
    const displayQuery = [advanced.query, basic.query, budget].filter(Boolean).join(' AND ');
    return { filters, displayQuery, hasUserConditions: !!(basic.explicitCount || advanced.count || budget || error), error };
  }
  function syncChoices() {
    for (const [selector, key] of [['#color-filters', 'colors'], ['#identity-filters', 'identities']]) {
      $$(selector + ' button').forEach(pick => pick.setAttribute('aria-pressed', String(filters[key].includes(pick.dataset.color))));
    }
    $('#color-relation').value = filters.colorRelation;
    $('#identity-relation').value = filters.identityRelation;
    $('#commander-filter').checked = filters.commanderOnly;
    fiveDhSettings.hidden = !fiveDh.checked;
    fiveDhPercent.disabled = !fiveDh.checked || !fiveDhOverage.checked;
  }
  function clear({ commanderOnly = false, silent = false } = {}) {
    filters = { ...defaults(), commanderOnly };
    fiveDh.checked = false;
    fiveDhOverage.checked = false;
    fiveDhPercent.value = defaultOverage;
    fiveDhSettings.open = false;
    conditionRoot = createGroup();
    types.clear();
    tags.clear();
    for (const [selector] of [...directFields, ...bounds]) $(selector).value = '';
    for (const input of $$('#mana-values input').concat($$('#rarity-filters input'))) input.checked = false;
    renderBuilder();
    syncChoices();
    if (!silent) changed();
  }
  function renderActiveFilters() {
    const items = [];
    const add = (label, remove) => items.push(button(label + ' ×', () => { remove(); changed(); }, 'filter-pill'));
    for (const [selector, label] of [['#card-name-filter', '卡名'], ['#oracle-filter', '规则'], ['#mana-cost-filter', '费用'], ['#artist-filter', '画家'], ['#set-filter', '系列'],
      ['#power-min', '力量 ≥'], ['#power-max', '力量 ≤'], ['#toughness-min', '防御力 ≥'], ['#toughness-max', '防御力 ≤']]) {
      if ($(selector).value.trim()) add(label + ' ' + $(selector).value, () => { $(selector).value = ''; });
    }
    for (const [key, label] of [['colors', '颜色'], ['identities', '标识色']]) {
      if (filters[key].length && (key !== 'identities' || !$('#identity-controls').hidden)) {
        add(label + ' ' + filters[key].map(color => COLOR_NAMES[color]).join(' / '), () => { filters[key] = []; });
      }
    }
    for (const [group, label] of [[types, '类别'], [tags, '功能标签']]) {
      if (group.count()) add(label + ' ' + group.count() + ' 项', group.clear);
    }
    const manaSelected = $$('#mana-values input:checked');
    if (manaSelected.length) {
      add('法术力值 ' + manaSelected.map(input => input.value === '9' ? '9+' : input.value).join(' / '),
        () => { for (const input of manaSelected) input.checked = false; });
    }
    for (const input of $$('#rarity-filters input:checked')) {
      add(rarities.find(option => option.value === input.value).label, () => { input.checked = false; });
    }
    if (fiveDh.checked) add('5DH 可用', () => { fiveDh.checked = false; });
    if (filters.commanderOnly) add('EDH 合法', () => { filters.commanderOnly = false; });
    if (conditionRoot.children.length) add('更多条件', () => { conditionRoot = createGroup(); renderBuilder(); });
    $('#active-filters').replaceChildren(...items);
    $('#active-filters').hidden = !items.length;
    $('#filter-count').textContent = items.length;
    $('#filter-count').hidden = !items.length;
  }
  function showError(message) { $('#filter-error').hidden = !message; $('#filter-error').textContent = message || ''; }
  function setMetadata({ sets = [], subtypes = [], typeVocabulary = [] } = {}) {
    setlist.replaceChildren(...sets.map(item => {
      const code = typeof item === 'string' ? item : item.code;
      return el('option', { value: code, label: item.name || code });
    }));
    types.setOptions([...typeOptions, ...(typeVocabulary.length ? typeVocabulary : subtypes.map(value => ({ value, label: value, detail: '副类别' })))]);
  }
  function setCommanderScope(identity, enabled) {
    $('#catalog-scope-label').hidden = identity === null;
    $('#catalog-scope-filter').checked = enabled;
    $('#catalog-scope-text').textContent = '和指挥官保持一致';
    $('#identity-controls').hidden = identity !== null && enabled;
  }

  for (const original of $$('#color-filters button')) {
    const copy = original.cloneNode(true);
    copy.setAttribute('aria-label', '标识色：' + COLOR_NAMES[copy.dataset.color]);
    $('#identity-filters').append(copy);
  }
  for (const [selector, key] of [['#color-filters', 'colors'], ['#identity-filters', 'identities']]) {
    $$(selector + ' button').forEach(pick => pick.addEventListener('click', () => { filters[key] = toggleColor(filters[key], pick.dataset.color); changed(); }));
  }
  for (const [selector, key] of [['#color-relation', 'colorRelation'], ['#identity-relation', 'identityRelation']]) {
    $(selector).addEventListener('change', event => { filters[key] = event.target.value; changed(); });
  }
  for (const [selector] of [...directFields, ...bounds]) $(selector).addEventListener('input', changed);
  mana.addEventListener('change', changed);
  $('#rarity-filters').addEventListener('change', changed);
  fiveDh.addEventListener('change', changed);
  fiveDhOverage.addEventListener('change', changed);
  fiveDhPercent.addEventListener('input', changed);
  $('#commander-filter').addEventListener('change', event => { filters.commanderOnly = event.target.checked; changed(); });
  clear({ commanderOnly: true, silent: true });
  return { getSearch, renderActiveFilters, reset: () => clear({ commanderOnly: true }), clear, showError, setMetadata, setCommanderScope, loadVocabulary };
}
