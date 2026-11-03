import { CONDITION_FIELDS, createCondition, createGroup, buildConditionQuery } from './query-builder.js';

const COLOR_NAMES = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿', C: '无色' };
const TYPE_NAMES = { Creature: '生物', Instant: '瞬间', Sorcery: '法术', Artifact: '神器', Enchantment: '结界', Planeswalker: '鹏洛客', Land: '地', Battle: '战役' };
const RELATIONS = { any: '包含任一', all: '包含全部', exact: '恰好', within: '仅限' };
const TAG_NAMES = { draw: '抓牌', 'draw-engine': '抓牌引擎', loot: '抓后弃', rummage: '弃后抓', wheel: '转轮', 'impulsive-draw': '冲动抓牌', ramp: '加速', 'mana-rock': '法术力石', 'mana-dork': '产费生物', ritual: '一次性产费', 'cost-reducer': '减费', 'land-ramp': '地加速', 'extra-land': '额外下地', tutor: '检索', 'tutor-land': '找地', 'tutor-creature': '找生物', 'tutor-artifact': '找神器', 'spot-removal': '单体去除', sweeper: '清场', counterspell: '反击', bounce: '回手', discard: '弃牌干扰', burn: '烧伤', theft: '偷取', flicker: '闪烁', recursion: '坟场回收', regrowth: '坟场回手', reanimate: '复活', 'hate-graveyard': '坟场针对', 'sacrifice-outlet': '牺牲源', protection: '保护', 'gives-hexproof': '赋予辟邪', 'gives-indestructible': '赋予不灭', fog: '防止战斗伤害', pillowfort: '枕头堡', anthem: '全队强化', overrun: '践踏爆发', 'extra-turn': '额外回合', 'extra-combat-phase': '额外战斗', 'drain-life': '吸血', lifegain: '获得生命', 'copy-spell': '复制咒语', 'copy-creature': '复制生物', landfall: '地落', 'sacrifice-matters': '牺牲协同', 'lifegain-matters': '加血协同', 'pp-counters-matter': '+1/+1 指示物协同', 'synergy-equipment': '武具协同', 'synergy-aura': '灵气协同', tax: '征税', hatebear: '干扰小生物', 'typal-elf': '妖精部族协同', 'typal-dragon': '龙部族协同', 'alternate-win-condition': '特殊胜利条件' };

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
function meaningfulRules(group) {
  return group.children.flatMap(child => child.kind === 'group' ? meaningfulRules(child) : String(child.value ?? '').trim() ? [child] : []);
}

export function initSearchFilters({ onChange }) {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));
  const defaults = () => ({ colors: [], colorRelation: 'any', identities: [], identityRelation: 'within', types: [], minManaValue: '', maxManaValue: '', commanderOnly: true, translation: 'all' });
  let filters = defaults();
  let conditionRoot = createGroup();
  let tags = [];
  let tagMatch = 'any';
  let mode = 'simple';
  let vocabularyPromise;
  const datalist = el('datalist', { id: 'tag-vocabulary' });
  const setlist = el('datalist', { id: 'set-vocabulary' });
  document.body.append(datalist, setlist);

  function changed() {
    syncSummary();
    onChange();
  }
  function loadVocabulary() {
    if (vocabularyPromise) return vocabularyPromise;
    vocabularyPromise = fetch(new URL('../data/tag-vocabulary.json', import.meta.url))
      .then(response => { if (!response.ok) throw new Error('标签词表暂时无法载入'); return response.json(); })
      .then(rows => {
        const fragment = document.createDocumentFragment();
        for (const [slug, name] of Object.entries(TAG_NAMES)) fragment.append(el('option', { value: slug, label: name + ' · ' + slug }));
        for (const tag of rows) {
          if (!Object.hasOwn(TAG_NAMES, tag.slug)) fragment.append(el('option', { value: tag.slug, label: tag.label || tag.slug }));
        }
        datalist.replaceChildren(fragment);
      }).catch(() => { vocabularyPromise = null; });
    return vocabularyPromise;
  }
  function setMode(value) {
    mode = value === 'advanced' ? 'advanced' : 'simple';
    $('#advanced-filters').hidden = mode !== 'advanced';
    $('#catalog-view').classList.toggle('is-advanced', mode === 'advanced');
    $('#filter-simple').setAttribute('aria-pressed', String(mode === 'simple'));
    $('#filter-advanced').setAttribute('aria-pressed', String(mode === 'advanced'));
    if (mode === 'advanced') loadVocabulary();
    syncSummary();
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
      if (spec.input === 'number') { value.min = '0'; value.step = 'any'; value.inputMode = 'decimal'; }
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
  function advancedQuery() {
    const built = buildConditionQuery(conditionRoot);
    const parts = [];
    if (tags.length) parts.push('(' + tags.map(tag => 'tag:' + tag).join(tagMatch === 'any' ? ' OR ' : ' AND ') + ')');
    if (built.query) parts.push(built.query);
    return { query: parts.join(' AND '), error: built.error, count: tags.length + meaningfulRules(conditionRoot).length + (filters.identities.length ? 1 : 0) + (filters.translation !== 'all' ? 1 : 0) };
  }
  function syncSummary() {
    const result = advancedQuery();
    $('#advanced-count').textContent = result.count;
    $('#advanced-count').hidden = !result.count;
    $('#advanced-retained').hidden = mode !== 'simple' || !result.count;
    $('#advanced-retained').textContent = result.count + ' 项高级条件仍在生效 · 点击查看';
    const preview = [];
    const op = { any: ':', all: '>=', exact: '=', within: '<=' };
    for (const [key, field, relation] of [['colors', 'c', 'colorRelation'], ['identities', 'ci', 'identityRelation']]) {
      const colors = filters[key];
      if (colors.length) {
        if (colors[0] === 'C') preview.push(field + '=无色');
        else if (filters[relation] === 'any') preview.push('(' + colors.map(color => field + ':' + color.toLowerCase()).join(' OR ') + ')');
        else preview.push(field + op[filters[relation]] + colors.join('').toLowerCase());
      }
    }
    if (filters.types.length) preview.push('(' + filters.types.map(type => 't:' + type.toLowerCase()).join(' OR ') + ')');
    if (filters.minManaValue !== '') preview.push('mv>=' + filters.minManaValue);
    if (filters.maxManaValue !== '') preview.push('mv<=' + filters.maxManaValue);
    if (filters.commanderOnly) preview.push('f:commander');
    if (result.query) preview.push(result.query);
    $('#generated-query').textContent = result.error || preview.join(' AND ') || '尚未添加搜索条件';
    if (filters.translation !== 'all') $('#generated-query').textContent += '\n中文内容：' + (filters.translation === 'translated' ? '已有中文规则' : '待补中文规则');
  }
  function sync() {
    for (const [selector, key] of [['#color-filters', 'colors'], ['#identity-filters', 'identities']]) {
      $$(selector + ' button').forEach(pick => pick.setAttribute('aria-pressed', String(filters[key].includes(pick.dataset.color))));
    }
    $$('#type-filters input').forEach(input => { input.checked = filters.types.includes(input.value); });
    $('#color-relation').value = filters.colorRelation;
    $('#identity-relation').value = filters.identityRelation;
    $('#mana-min').value = filters.minManaValue;
    $('#mana-max').value = filters.maxManaValue;
    $('#mana-label').textContent = filters.minManaValue === '' && filters.maxManaValue === '' ? '不限' : (filters.minManaValue === '' ? '0' : filters.minManaValue) + ' – ' + (filters.maxManaValue === '' ? '不限' : filters.maxManaValue);
    $('#translation-filter').value = filters.translation;
    $('#commander-filter').checked = filters.commanderOnly;
    $('#tag-match').value = tagMatch;
    $$('[data-tag]').forEach(pick => pick.setAttribute('aria-pressed', String(tags.includes(pick.dataset.tag))));
    syncSummary();
  }
  function reset() { filters = defaults(); conditionRoot = createGroup(); tags = []; tagMatch = 'any'; renderBuilder(); sync(); changed(); }
  function getSearch() {
    const result = advancedQuery();
    const badNumber = ['#mana-min', '#mana-max'].some(selector => $(selector).validity.badInput);
    const error = badNumber ? '法术力值需要填写非负数字，留空表示不限。' : result.error;
    return { filters: { ...filters, colors: [...filters.colors], identities: [...filters.identities], types: [...filters.types] }, query: result.query, error };
  }
  function renderActiveFilters() {
    const wrap = $('#active-filters');
    const items = [];
    if (filters.colors.length) items.push({ label: '颜色：' + RELATIONS[filters.colorRelation] + filters.colors.map(color => COLOR_NAMES[color]).join(' / '), remove: () => { filters.colors = []; } });
    if (filters.identities.length) items.push({ label: '标识色：' + RELATIONS[filters.identityRelation] + filters.identities.map(color => COLOR_NAMES[color]).join(' / '), advanced: true, remove: () => { filters.identities = []; } });
    for (const type of filters.types) items.push({ label: TYPE_NAMES[type], remove: () => { filters.types = filters.types.filter(value => value !== type); } });
    if (filters.minManaValue !== '') items.push({ label: '法术力值 ≥ ' + filters.minManaValue, remove: () => { filters.minManaValue = ''; } });
    if (filters.maxManaValue !== '') items.push({ label: '法术力值 ≤ ' + filters.maxManaValue, remove: () => { filters.maxManaValue = ''; } });
    if (filters.commanderOnly) items.push({ label: 'EDH 合法', remove: () => { filters.commanderOnly = false; } });
    if (filters.translation !== 'all') items.push({ label: filters.translation === 'translated' ? '已有中文' : '中文待补', advanced: true, remove: () => { filters.translation = 'all'; } });
    for (const tag of tags) items.push({ label: (tagMatch === 'any' ? '任选标签：' : '必需标签：') + tag, advanced: true, remove: () => { tags = tags.filter(value => value !== tag); } });
    const rules = meaningfulRules(conditionRoot);
    if (rules.length) items.push({ label: (conditionRoot.exclude ? '排除组合：' : '组合条件：') + rules.length + ' 项', advanced: true, remove: () => { conditionRoot = createGroup(); renderBuilder(); } });
    wrap.replaceChildren();
    for (const item of items) {
      const pill = button(item.label + ' ×', () => { item.remove(); sync(); changed(); }, 'filter-pill' + (item.advanced ? ' advanced-pill' : ''));
      pill.setAttribute('aria-label', '移除筛选：' + item.label);
      wrap.append(pill);
    }
    wrap.hidden = !items.length;
    $('#filter-count').hidden = !items.length;
    $('#filter-count').textContent = items.length;
  }
  function showError(message) { $('#filter-error').hidden = !message; $('#filter-error').textContent = message || ''; }
  function setCatalog(cards) {
    const sets = new Map();
    for (const card of cards) for (const version of card.versions || []) {
      if (version.set && !sets.has(version.set)) sets.set(version.set, version.setName || version.set);
    }
    const fragment = document.createDocumentFragment();
    for (const [code, name] of [...sets].sort((a, b) => a[0].localeCompare(b[0]))) fragment.append(el('option', { value: code, label: name + ' · ' + code.toUpperCase() }));
    setlist.replaceChildren(fragment);
  }

  for (const original of $$('#color-filters button')) {
    const copy = original.cloneNode(true);
    copy.setAttribute('aria-label', '标识色：' + COLOR_NAMES[copy.dataset.color]);
    $('#identity-filters').append(copy);
  }
  for (const [selector, key] of [['#color-filters', 'colors'], ['#identity-filters', 'identities']]) {
    $$(selector + ' button').forEach(pick => pick.addEventListener('click', () => { filters[key] = toggleColor(filters[key], pick.dataset.color); sync(); changed(); }));
  }
  for (const [selector, key] of [['#color-relation', 'colorRelation'], ['#identity-relation', 'identityRelation'], ['#translation-filter', 'translation']]) {
    $(selector).addEventListener('change', event => { filters[key] = event.target.value; changed(); });
  }
  for (const [selector, key] of [['#mana-min', 'minManaValue'], ['#mana-max', 'maxManaValue']]) {
    $(selector).addEventListener('input', event => { filters[key] = event.target.value; $('#mana-label').textContent = filters.minManaValue === '' && filters.maxManaValue === '' ? '不限' : (filters.minManaValue || '0') + ' – ' + (filters.maxManaValue || '不限'); changed(); });
  }
  $$('#type-filters input').forEach(input => input.addEventListener('change', () => { filters.types = $$('#type-filters input:checked').map(item => item.value); changed(); }));
  $('#commander-filter').addEventListener('change', event => { filters.commanderOnly = event.target.checked; changed(); });
  $('#tag-match').addEventListener('change', event => { tagMatch = event.target.value; changed(); });
  $$('[data-tag]').forEach(pick => pick.addEventListener('click', () => { tags = tags.includes(pick.dataset.tag) ? tags.filter(tag => tag !== pick.dataset.tag) : [...tags, pick.dataset.tag]; sync(); changed(); }));
  $('#add-tag-condition').addEventListener('click', () => addRule(conditionRoot, 'tag'));
  $('#filter-simple').addEventListener('click', () => setMode('simple'));
  $('#filter-advanced').addEventListener('click', () => setMode('advanced'));
  $('#advanced-retained').addEventListener('click', () => setMode('advanced'));
  renderBuilder(); sync(); setMode('simple');
  return { getSearch, renderActiveFilters, reset, setMode, showError, setCatalog };
}
