const textCache = new WeakMap();
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const typeAliases = { 生物: 'creature', 地: 'land', 地牌: 'land', 神器: 'artifact', 结界: 'enchantment', 瞬间: 'instant', 法术: 'sorcery', 鹏洛客: 'planeswalker', 战役: 'battle', 传奇: 'legendary', 基本: 'basic', 雪境: 'snow', 人类: 'human', 精灵: 'elf', 龙: 'dragon', 灵俑: 'zombie', 地精: 'goblin' };
const fieldAliases = { 名称: 'name', 规则: 'o', 类型: 't', 颜色: 'c', 标识色: 'ci', 法术力值: 'mv', 系列: 'set', 编号: 'cn', 稀有度: 'r', 语言: 'lang', 赛制: 'f', 功能: 'tag', oracle: 'o', type: 't', color: 'c', id: 'ci', identity: 'ci', cmc: 'mv', e: 'set', number: 'cn', rarity: 'r', language: 'lang', format: 'f', otag: 'tag', function: 'tag' };
const tagAliases = {
  抓牌: ['card-draw', 'draw'], draw: ['card-draw', 'draw'],
  加速: ['mana-ramp', 'ramp'], ramp: ['mana-ramp', 'ramp'],
  找地: ['tutor-land', 'land-tutor'],
  单体去除: ['spot-removal'], 去除: ['removal', 'spot-removal'],
  清场: ['sweeper', 'board-wipe'], boardwipe: ['sweeper', 'board-wipe'],
  反击: ['counterspell', 'counter-ability'],
  坟场互动: ['recursion', 'hate-graveyard', 'castable-from-graveyard', 'gives-castable-from-graveyard'],
};
const colorAliases = { 白: 'w', 蓝: 'u', 黑: 'b', 红: 'r', 绿: 'g', white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g', colorless: '', 无色: '', c: '' };
const rarityAliases = { 普通: 'common', 非普通: 'uncommon', 稀有: 'rare', 秘稀: 'mythic', c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' };
const printingFields = new Set(['set', 'cn', 'lang', 'r']);

export class QueryError extends Error {
  constructor(message, position = 0) { super(message); this.name = 'QueryError'; this.position = position; }
}
export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}
function fields(card) {
  let result = textCache.get(card);
  if (!result) {
    const faces = card.faces?.length ? card.faces : [card];
    const names = [card.name, card.zhName, ...(card.aliases || []), ...faces.flatMap(face => [face.name, face.zhName])];
    const oracle = faces.flatMap(face => [face.oracleText, face.zhText]);
    const types = faces.flatMap(face => [face.typeLine, face.zhTypeLine]);
    result = { name: names.map(normalizeText).join('\n'), o: oracle.map(normalizeText).join('\n'), t: types.map(normalizeText).join('\n') };
    result.all = result.name + '\n' + result.o + '\n' + result.t;
    textCache.set(card, result);
  }
  return result;
}

function tokenize(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) { i++; continue; }
    const start = i;
    if ('()-'.includes(query[i])) { tokens.push({ kind: query[i], start, value: query[i++] }); continue; }
    let value = '', quoted = false, wasQuoted = false;
    while (i < query.length) {
      const char = query[i];
      if (char === '"') { quoted = !quoted; wasQuoted = true; i++; continue; }
      if (char === '\\' && quoted && ['"', '\\'].includes(query[i + 1])) { value += query[i + 1]; i += 2; continue; }
      if (!quoted && (/\s/.test(char) || '()'.includes(char))) break;
      value += char; i++;
    }
    if (quoted) throw new QueryError('引号没有闭合，请补上右引号', start);
    if (!value) throw new QueryError('搜索条件不能为空', start);
    const upper = value.toUpperCase();
    tokens.push({ kind: !wasQuoted && ['AND', 'OR', 'NOT'].includes(upper) ? upper : 'term', value, start });
  }
  return tokens;
}

export function parseQuery(query = '') {
  query = String(query).trim();
  if (query.length > 1024) throw new QueryError('搜索条件请保持在 1024 个字符以内', 1024);
  const tokens = tokenize(query);
  let i = 0, depth = 0;
  if (!tokens.length) return { type: 'all', hasPrinting: false };
  function atom() {
    const token = tokens[i++];
    if (!token) throw new QueryError('搜索条件不完整', query.length);
    if (token.kind === '-' || token.kind === 'NOT') return { type: 'not', value: atom() };
    if (token.kind === '(') {
      if (++depth > 24) throw new QueryError('括号嵌套过深', token.start);
      const expression = or();
      if (tokens[i]?.kind !== ')') throw new QueryError('括号没有闭合', token.start);
      i++; depth--; return expression;
    }
    if (token.kind !== 'term') throw new QueryError('这里需要一个搜索条件', token.start);
    const match = token.value.match(/^([^:<>=]+)(<=|>=|:|=|<|>)(.*)$/);
    if (!match) return { type: 'term', field: 'all', op: ':', value: normalizeText(token.value), position: token.start };
    const fieldName = normalizeText(match[1]);
    const field = fieldAliases[fieldName] || fieldName;
    if (!['name', 'o', 't', 'c', 'ci', 'mv', 'set', 'cn', 'r', 'lang', 'f', 'tag'].includes(field)) throw new QueryError(`不支持字段“${match[1]}”，可打开语法帮助查看`, token.start);
    if (!match[3]) throw new QueryError(`字段“${match[1]}”缺少查询值`, token.start + match[1].length + match[2].length);
    return { type: 'term', field, op: match[2], value: normalizeText(match[3]), position: token.start };
  }
  function and() {
    let expression = atom();
    while (i < tokens.length && !['OR', ')'].includes(tokens[i].kind)) {
      if (tokens[i].kind === 'AND') i++;
      expression = { type: 'and', left: expression, right: atom() };
    }
    return expression;
  }
  function or() {
    let expression = and();
    while (tokens[i]?.kind === 'OR') { i++; expression = { type: 'or', left: expression, right: and() }; }
    return expression;
  }
  const tree = or();
  if (i !== tokens.length) throw new QueryError('多余的右括号', tokens[i].start);
  tree.hasPrinting = containsPrinting(tree);
  return tree;
}
function containsPrinting(node) {
  if (node.type === 'term') return printingFields.has(node.field);
  return ['left', 'right', 'value'].some(key => node[key] && typeof node[key] === 'object' && containsPrinting(node[key]));
}
function compare(actual, expected, op) {
  switch (op) {
    case ':': case '=': return actual === expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    default: return false;
  }
}
function parseColors(value, position) {
  value = normalizeText(value);
  const mapped = Object.hasOwn(colorAliases, value) ? colorAliases[value] : value.replace(/[白蓝黑红绿]/g, char => colorAliases[char]).replace(/[,，\s+]/g, '');
  if (!/^[wubrg]*$/.test(mapped)) throw new QueryError('颜色使用 W/U/B/R/G，或白、蓝、黑、红、绿、无色', position);
  return [...new Set(mapped.split(''))];
}
function colorMatches(actual = [], expected, op) {
  const colors = new Set(actual.map(color => color.toLowerCase()));
  const hasAll = expected.every(color => colors.has(color));
  const subset = [...colors].every(color => expected.includes(color));
  if (op === '=') return hasAll && subset;
  if (op === '<=') return subset;
  if (op === '<') return subset && colors.size < expected.length;
  if (op === '>') return hasAll && colors.size > expected.length;
  if (op === '>=') return hasAll;
  return expected.length ? hasAll : colors.size === 0;
}

function compile(node, hasTags) {
  if (node.type === 'all') return () => true;
  if (node.type === 'not') { const test = compile(node.value, hasTags); return (card, version) => !test(card, version); }
  if (node.type === 'and' || node.type === 'or') {
    const left = compile(node.left, hasTags), right = compile(node.right, hasTags);
    return node.type === 'and' ? (card, version) => left(card, version) && right(card, version) : (card, version) => left(card, version) || right(card, version);
  }
  const { field, value, op, position } = node;
  if (!['c', 'ci', 'mv'].includes(field) && ![':', '='].includes(op)) throw new QueryError(`字段“${field}”不支持运算符 ${op}`, position);
  if (field === 'mv') {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new QueryError('法术力值需要非负数字，例如 mv<=3', position);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new QueryError('法术力值需要非负有限数字，例如 mv<=3', position);
    return card => compare(Number(card.manaValue ?? 0), number, op);
  }
  if (field === 'c' || field === 'ci') {
    const colors = parseColors(value, position);
    return card => colorMatches(field === 'ci' ? card.colorIdentity : card.colors, colors, op);
  }
  if (field === 'all' || ['name', 'o', 't'].includes(field)) {
    const needle = field === 't' ? (typeAliases[value] || value) : value;
    return card => {
      const haystack = fields(card)[field];
      return op === '=' ? haystack.split('\n').includes(needle) : haystack.includes(needle) || (field === 't' && needle !== value && haystack.includes(value));
    };
  }
  if (field === 'f') {
    if (!['commander', 'edh'].includes(value)) throw new QueryError('首版赛制筛选支持 f:commander', position);
    return card => card.legalities?.commander === 'legal';
  }
  if (field === 'tag') {
    if (!hasTags) throw new QueryError('当前卡库尚未载入功能标签', position);
    const candidates = tagAliases[value] || [value.replace(/ /g, '-')];
    return card => (card.tags || []).some(tag => candidates.includes(normalizeText(typeof tag === 'string' ? tag : tag.slug || tag.name)));
  }
  if (field === 'r') {
    const rarity = rarityAliases[value] || value;
    if (!['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].includes(rarity)) throw new QueryError('稀有度可用 common / uncommon / rare / mythic', position);
    return (card, version) => normalizeText(version?.rarity ?? card.rarity) === rarity;
  }
  if (field === 'set') return (card, version) => normalizeText(version?.set ?? card.set) === value;
  if (field === 'cn') return (card, version) => normalizeText(version?.collectorNumber ?? card.collectorNumber) === value;
  if (field === 'lang') return (card, version) => normalizeText(version?.lang ?? card.lang) === value;
  return () => false;
}

function compileColorFilter(selected = [], relation, label) {
  if (!Array.isArray(selected)) throw new QueryError(`${label}筛选需要颜色列表`);
  if (!['any', 'all', 'exact', 'within'].includes(relation)) throw new QueryError(`${label}匹配方式无效，请选择包含任一、包含全部、恰好或限定范围`);
  if (!selected.length) return () => true;
  const colors = new Set();
  let colorless = false;
  for (const selection of selected) {
    const value = normalizeText(selection);
    if (['c', 'colorless', '无色'].includes(value)) colorless = true;
    else {
      if (!value) throw new QueryError(`${label}筛选包含空颜色`);
      for (const color of parseColors(value, 0)) colors.add(color);
    }
  }
  if (colorless && colors.size && ['all', 'exact'].includes(relation)) throw new QueryError(`${label}选择无色时，“包含全部”和“恰好”不能同时选择其他颜色`);
  const expected = [...colors];
  // “限定范围” includes colorless cards; “包含任一” includes them only when C is selected.
  if (relation === 'within') return actual => colorMatches(actual, expected, '<=');
  if (relation === 'any') return (actual = []) => actual.length ? actual.some(color => colors.has(normalizeText(color))) : colorless;
  if (colorless) return (actual = []) => actual.length === 0;
  return actual => colorMatches(actual, expected, relation === 'all' ? '>=' : '=');
}
function manaBound(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  if (!['string', 'number'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) < 0) throw new QueryError(`法术力值${label}需要非负有限数字`);
  return Number(value);
}
function prepareFilters(filters) {
  const legacyIdentity = filters.colorMode === 'identity';
  const colorTest = compileColorFilter(filters.colors, filters.colorRelation ?? (legacyIdentity ? 'within' : 'any'), '颜色');
  const identityTest = compileColorFilter(filters.identities, filters.identityRelation ?? 'within', '标识色');
  const minManaValue = manaBound(filters.minManaValue, '下限');
  const maxManaValue = manaBound(filters.maxManaValue, '上限');
  if (minManaValue !== null && maxManaValue !== null && minManaValue > maxManaValue) throw new QueryError('法术力值下限不能大于上限');
  return { ...filters, colorTest, identityTest, legacyIdentity, minManaValue, maxManaValue };
}
function filterCard(card, filters) {
  if (filters.commanderOnly && card.legalities?.commander !== 'legal') return false;
  if (!filters.colorTest(filters.legacyIdentity ? card.colorIdentity : card.colors)) return false;
  if (!filters.identityTest(card.colorIdentity)) return false;
  if (filters.types?.length && !filters.types.some(type => {
    const value = normalizeText(type); return fields(card).t.includes(typeAliases[value] || value);
  })) return false;
  if (filters.minManaValue !== null && Number(card.manaValue ?? 0) < filters.minManaValue) return false;
  if (filters.maxManaValue !== null && Number(card.manaValue ?? 0) > filters.maxManaValue) return false;
  if (filters.translation && filters.translation !== 'all') {
    const required = (card.faces?.length ? card.faces : [card]).filter(face => String(face.oracleText || '').trim());
    const complete = required.every(face => String(face.zhText || '').trim());
    if ((filters.translation === 'translated' && !complete) || (filters.translation === 'missing' && complete)) return false;
  }
  return true;
}

// Validate user input before requesting card data; tag availability is checked
// separately by searchCards after the catalog has loaded.
export function validateSearch(query = '', filters = {}) {
  try {
    prepareFilters(filters);
    compile(parseQuery(query), true);
    return null;
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { message: error.message, position: error.position };
  }
}

export function searchCards(cards, query = '', filters = {}, sort = 'name') {
  try {
    const preparedFilters = prepareFilters(filters);
    const tree = parseQuery(query);
    const test = compile(tree, cards.some(card => card.tags?.length));
    const matches = [];
    for (const card of cards) {
      if (!filterCard(card, preparedFilters)) continue;
      if (!tree.hasPrinting) { if (test(card, null)) matches.push(card); continue; }
      const versions = card.versions?.length ? card.versions : [card];
      const matchingVersions = versions.filter(version => test(card, version));
      if (matchingVersions.length) matches.push({ ...card, matchingVersions });
    }
    const byName = (a, b) => collator.compare(a.zhName || a.name, b.zhName || b.name) || collator.compare(a.name, b.name);
    const sorter = sort === 'mana-asc' ? (a, b) => (a.manaValue || 0) - (b.manaValue || 0) || byName(a, b)
      : sort === 'mana-desc' ? (a, b) => (b.manaValue || 0) - (a.manaValue || 0) || byName(a, b)
      : sort === 'released' ? (a, b) => String(b.releasedAt || '').localeCompare(String(a.releasedAt || '')) || byName(a, b) : byName;
    matches.sort(sorter);
    return { cards: matches, total: matches.length, error: null };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { cards: [], total: 0, error: { message: error.message, position: error.position } };
  }
}
