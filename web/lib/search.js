import { usdToCny } from './catalog-price.js';
import { localizedTagSlugs } from './tag-names.js';

const textCache = new WeakMap();
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const typeAliases = { 生物: 'creature', 地: 'land', 地牌: 'land', 神器: 'artifact', 结界: 'enchantment', 瞬间: 'instant', 法术: 'sorcery', 鹏洛客: 'planeswalker', 战役: 'battle', 亲缘: 'kindred', 部族: 'tribal', 传奇: 'legendary', 基本: 'basic', 雪境: 'snow', 雪: 'snow', 世界: 'world', 持续: 'ongoing', 人类: 'human', 精灵: 'elf', 妖精: 'elf', 龙: 'dragon', 灵俑: 'zombie', 地精: 'goblin' };
const fieldAliases = { 名称: 'name', 规则: 'o', 类型: 't', 类别: 't', 法术力费用: 'm', 画家: 'a', mana: 'm', manacost: 'm', artist: 'a', 颜色: 'c', 标识色: 'ci', 法术力值: 'mv', 攻击力: 'pow', 力量: 'pow', 防御力: 'tou', 防御: 'tou', 系列: 'set', 编号: 'cn', 稀有度: 'r', 语言: 'lang', 赛制: 'f', 功能: 'tag', oracle: 'o', type: 't', color: 'c', id: 'ci', identity: 'ci', cmc: 'mv', power: 'pow', toughness: 'tou', e: 'set', number: 'cn', rarity: 'r', language: 'lang', format: 'f', otag: 'tag', function: 'tag' };
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
const printingFields = new Set(['set', 'cn', 'lang', 'r', 'a']);

export function normalizeManaCost(value) {
  return normalizeText(value).replace(/\s+/g, '').replace(/{([^{}]+)}|\d+|[wubrgcsxyz]/g, (token, braced) => '{' + (braced ?? token) + '}');
}

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
    tokens.push({ kind: !wasQuoted && ['AND', 'OR', 'NOT'].includes(upper) ? upper : 'term', value, start, end: i, literal: query[start] === '"' });
  }
  return tokens;
}

// Ordering is global metadata, kept outside the boolean card predicate. Retain
// original slices so quotes, escapes, and error positions survive extraction.
export function extractSearchOptions(query = '', fallbackSort = 'name') {
  query = String(query);
  if (query.trim().length > 1024) throw new QueryError('搜索条件请保持在 1024 个字符以内', 1024);
  const tokens = tokenize(query), removed = new Set();
  let depth = 0, order = null, direction = null;
  const metadata = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === '(') depth++;
    if (token.kind === ')') depth--;
    if (token.kind !== 'term' || token.literal) continue;
    const match = token.value.match(/^(order|sort|dir):(.+)$/i);
    if (!match) continue;
    if (depth !== 0 || ['-', 'NOT'].includes(tokens[i - 1]?.kind)) throw new QueryError('排序选项请单独写在括号外，不能取反', token.start);
    const field = match[1].toLowerCase(), value = normalizeText(match[2]);
    if (field === 'dir') {
      if (direction !== null) throw new QueryError('只能指定一个排序方向', token.start);
      if (!['asc', 'desc'].includes(value)) throw new QueryError('排序方向可用 dir:asc 或 dir:desc', token.start);
      direction = value;
    } else {
      if (order !== null) throw new QueryError('只能指定一个排序方式', token.start);
      if (!['name', 'cmc', 'mv', 'released', 'edhrec', 'usd'].includes(value)) throw new QueryError('排序可用 name / mv / released / edhrec / usd', token.start);
      order = value;
    }
    metadata.push(i);
  }
  for (const index of metadata) {
    removed.add(index);
    let previous = index - 1, next = index + 1;
    while (removed.has(previous)) previous--;
    while (removed.has(next)) next++;
    if (tokens[previous]?.kind === 'AND') removed.add(previous);
    else if (tokens[next]?.kind === 'AND') removed.add(next);
  }
  // Character offsets above use JS UTF-16 positions, including non-BMP names.
  let stripped = query;
  for (const index of [...removed].sort((a, b) => tokens[b].start - tokens[a].start)) {
    const token = tokens[index];
    stripped = stripped.slice(0, token.start) + ' '.repeat(token.end - token.start) + stripped.slice(token.end);
  }
  let sort = ['name', 'mana-asc', 'mana-desc', 'released', 'edhrec', 'usd-asc', 'usd-desc'].includes(fallbackSort) ? fallbackSort : 'name';
  if (order !== null) sort = ['cmc', 'mv'].includes(order) ? 'mana-asc' : order === 'usd' ? 'usd-asc' : order;
  const descending = direction === null ? ['mana-desc', 'usd-desc', 'released'].includes(sort) : direction === 'desc';
  if (sort.startsWith('mana-')) sort = descending ? 'mana-desc' : 'mana-asc';
  if (sort.startsWith('usd-')) sort = descending ? 'usd-desc' : 'usd-asc';
  return { query: stripped.trim(), sort, descending, hasOrder: order !== null, hasDirection: direction !== null };
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
    if (token.literal) return { type: 'term', field: 'all', op: ':', value: normalizeText(token.value), position: token.start };
    const match = token.value.match(/^([^:<>=]+)(<=|>=|:|=|<|>)(.*)$/);
    if (!match) return { type: 'term', field: 'all', op: ':', value: normalizeText(token.value), position: token.start };
    const fieldName = normalizeText(match[1]);
    const field = fieldAliases[fieldName] || fieldName;
    if (!['name', 'o', 't', 'c', 'ci', 'mv', 'pow', 'tou', 'set', 'cn', 'r', 'lang', 'f', 'tag', 'is', 'm', 'a', 'cny'].includes(field)) throw new QueryError(`不支持字段“${match[1]}”，可打开语法帮助查看`, token.start);
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
  tree.hasPrinting = containsField(tree, printingFields);
  tree.hasCnyPrice = containsField(tree, cnyFields);
  return tree;
}
const cnyFields = new Set(['cny']);
function containsField(node, fields) {
  if (node.type === 'term') return fields.has(node.field);
  return ['left', 'right', 'value'].some(key => node[key] && typeof node[key] === 'object' && containsField(node[key], fields));
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
function containsType(haystack, needle) {
  // English subtypes are whole type words: Rat must not match Pirate, and
  // Wall must not match Wallaby. Chinese subtype suggestions are complete words.
  if (/^[a-z][a-z -]*$/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z])${escaped}(?=$|[^a-z])`).test(haystack);
  }
  if (/^[\p{Script=Han}]+$/u.test(needle)) return haystack.split(/[\s—–～~／/]+/u).includes(needle);
  return haystack.includes(needle);
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
  if (!['c', 'ci', 'mv', 'pow', 'tou', 'cny'].includes(field) && ![':', '='].includes(op)) throw new QueryError(`字段“${field}”不支持运算符 ${op}`, position);
  if (field === 'pow' || field === 'tou') {
    const number = characteristicNumber(value);
    if (number === null) throw new QueryError(`${field === 'pow' ? '攻击力' : '防御力'}需要有限数字，例如 ${field}>=-1`, position);
    const property = field === 'pow' ? 'power' : 'toughness';
    return (card, version, face) => (face ? [face] : card.faces?.length ? card.faces : [card]).some(row => {
      const actual = characteristicNumber(row[property]);
      return actual !== null && compare(actual, number, op);
    });
  }
  if (field === 'cny') {
    const limit = characteristicNumber(value);
    if (limit === null || limit < 0) throw new QueryError('人民币价格需要非负数字，例如 cny<=5', position);
    return (card, version) => {
      const price = usdToCny(version ? version.usd : lowestUsdPrice(card));
      return price !== null && compare(price, limit, op);
    };
  }
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
    return (card, version, face) => {
      const haystack = field === 't' && face ? [face.typeLine, face.zhTypeLine].map(normalizeText).join('\n') : fields(card)[field];
      if (op === '=') return haystack.split('\n').includes(needle);
      return field === 't' ? containsType(haystack, needle) : haystack.includes(needle);
    };
  }
  if (field === 'f') {
    if (!['commander', 'edh'].includes(value)) throw new QueryError('首版赛制筛选支持 f:commander', position);
    return card => card.legalities?.commander === 'legal';
  }
  if (field === 'is') {
    if (!['translated', 'untranslated'].includes(value)) throw new QueryError('译文状态可用 is:translated 或 is:untranslated', position);
    return card => hasCompleteTranslation(card) === (value === 'translated');
  }
  if (field === 'tag') {
    if (!hasTags) throw new QueryError('当前卡库尚未载入功能标签', position);
    const candidates = tagAliases[value] || localizedTagSlugs(value) || [value, value.replace(/ /g, '-')];
    return card => (card.tags || []).some(tag => candidates.includes(normalizeText(typeof tag === 'string' ? tag : tag.slug || tag.name)));
  }
  if (field === 'm') {
    const cost = normalizeManaCost(value);
    if (!/^(?:\{[a-z0-9½∞]+(?:\/[a-z0-9]+)*\})+$/.test(cost)) throw new QueryError('请输入法术力符号，例如 {2}{G}{G}', position);
    return card => (card.faces?.length ? card.faces : [card]).some(face => {
      const actual = normalizeManaCost(face.manaCost);
      return op === '=' ? actual === cost : actual.includes(cost);
    });
  }
  if (field === 'a') return (card, version) => {
    const name = normalizeText(version?.artist ?? card.artist);
    return op === '=' ? name === value : name.includes(value);
  };
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

function characteristicNumber(value) {
  if (!['string', 'number'].includes(typeof value) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value).trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function hasCompleteTranslation(card) {
  return (card.faces?.length ? card.faces : [card]).filter(face => String(face.oracleText || '').trim()).every(face => String(face.zhText || '').trim());
}
function hasCharacteristic(node) {
  if (node.type === 'term') return ['pow', 'tou'].includes(node.field);
  return ['left', 'right', 'value'].some(key => node[key] && typeof node[key] === 'object' && hasCharacteristic(node[key]));
}
// Intersect candidate faces for AND so a 1/8 front and an 8/1 back cannot
// accidentally satisfy pow>=5 tou>=5. Negation excludes the whole card.
function compileFaceTree(node, hasTags) {
  const all = card => (card.faces?.length ? card.faces : [card]).map((_, index) => index);
  if (node.type === 'not') {
    const child = compileFaceTree(node.value, hasTags);
    return (card, version) => child(card, version).length ? [] : all(card);
  }
  if (node.type === 'and' || node.type === 'or') {
    const left = compileFaceTree(node.left, hasTags), right = compileFaceTree(node.right, hasTags);
    return (card, version) => {
      const a = left(card, version), b = right(card, version);
      return node.type === 'and' ? a.filter(index => b.includes(index)) : [...new Set([...a, ...b])];
    };
  }
  const leaf = compile(node, hasTags);
  return (card, version) => (card.faces?.length ? card.faces : [card]).flatMap((face, index) => leaf(card, version, face) ? [index] : []);
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
    const value = normalizeText(type); return containsType(fields(card).t, typeAliases[value] || value);
  })) return false;
  if (filters.minManaValue !== null && Number(card.manaValue ?? 0) < filters.minManaValue) return false;
  if (filters.maxManaValue !== null && Number(card.manaValue ?? 0) > filters.maxManaValue) return false;
  if (filters.translation && filters.translation !== 'all') {
    const complete = hasCompleteTranslation(card);
    if ((filters.translation === 'translated' && !complete) || (filters.translation === 'missing' && complete)) return false;
  }
  return true;
}

// Validate user input before requesting card data; tag availability is checked
// separately by searchCards after the catalog has loaded.
export function validateSearch(query = '', filters = {}) {
  try {
    prepareFilters(filters);
    const options = extractSearchOptions(query);
    compile(parseQuery(options.query), true);
    return null;
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { message: error.message, position: error.position };
  }
}

function lowestUsdPrice(card, versions = card.versions?.length ? card.versions : [card]) {
  const prices = versions.map(version => version.usd).filter(price => Number.isFinite(price) && price >= 0);
  return prices.length ? Math.min(...prices) : null;
}

export function searchCards(cards, query = '', filters = {}, sort = 'name') {
  try {
    const preparedFilters = prepareFilters(filters);
    const options = extractSearchOptions(query, sort);
    const tree = parseQuery(options.query);
    const hasTags = cards.some(card => card.tags?.length);
    let test = compile(tree, hasTags);
    if (hasCharacteristic(tree)) {
      const faceTest = compileFaceTree(tree, hasTags);
      test = (card, version) => faceTest(card, version).length > 0;
    }
    const matches = [];
    const sortByPrice = options.sort.startsWith('usd-');
    function withPrice(card, versions) {
      if (!sortByPrice && !tree.hasCnyPrice) return card;
      const usdPrice = lowestUsdPrice(card, versions);
      return { ...card, usdPrice, ...(tree.hasCnyPrice ? { cnyPrice: usdToCny(usdPrice) } : {}) };
    }
    for (const card of cards) {
      if (!filterCard(card, preparedFilters)) continue;
      if (!tree.hasPrinting) {
        if (test(card, null)) matches.push(withPrice(card));
        continue;
      }
      const versions = card.versions?.length ? card.versions : [card];
      const matchingVersions = versions.filter(version => test(card, version));
      if (matchingVersions.length) matches.push(withPrice({ ...card, matchingVersions }, matchingVersions));
    }
    const byName = (a, b) => collator.compare(a.zhName || a.name, b.zhName || b.name) || collator.compare(a.name, b.name) || String(a.id || '').localeCompare(String(b.id || ''));
    const direction = options.descending ? -1 : 1;
    const ranked = card => Number.isInteger(card.edhrecRank) && card.edhrecRank > 0;
    const sorter = sortByPrice ? (a, b) => {
      if (a.usdPrice === null || b.usdPrice === null) return (a.usdPrice === null) - (b.usdPrice === null) || byName(a, b);
      return direction * (a.usdPrice - b.usdPrice) || byName(a, b);
    } : options.sort.startsWith('mana-') ? (a, b) => direction * ((a.manaValue || 0) - (b.manaValue || 0)) || byName(a, b)
      : options.sort === 'released' ? (a, b) => direction * String(a.releasedAt || '').localeCompare(String(b.releasedAt || '')) || byName(a, b)
      : options.sort === 'edhrec' ? (a, b) => {
        if (ranked(a) !== ranked(b)) return ranked(a) ? -1 : 1;
        return (ranked(a) ? direction * (a.edhrecRank - b.edhrecRank) : 0) || byName(a, b);
      } : (a, b) => direction * byName(a, b);
    matches.sort(sorter);
    return { cards: matches, total: matches.length, error: null };
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    return { cards: [], total: 0, error: { message: error.message, position: error.position } };
  }
}
