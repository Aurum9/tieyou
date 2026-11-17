import { CNY_FEN_PER_USD, usdToCny } from '../web/lib/catalog-price.js';
import { parseQuery, extractSearchOptions, validateSearch, normalizeText, normalizeManaCost, QueryError } from '../web/lib/search.js';
import { parseDeckText } from '../web/lib/decks.js';
import { commanderScopeQuery, deckTagQuery } from '../web/lib/deck-target.js';
import { localizedTagSlugs } from '../web/lib/tag-names.js';

// Values share the public query language. The parser itself stays in search.js.
const typeAliases = { 生物: 'creature', 地: 'land', 地牌: 'land', 神器: 'artifact', 结界: 'enchantment', 瞬间: 'instant', 法术: 'sorcery', 鹏洛客: 'planeswalker', 战役: 'battle', 亲缘: 'kindred', 部族: 'tribal', 传奇: 'legendary', 基本: 'basic', 雪境: 'snow', 雪: 'snow', 世界: 'world', 持续: 'ongoing', 人类: 'human', 精灵: 'elf', 妖精: 'elf', 龙: 'dragon', 灵俑: 'zombie', 地精: 'goblin' };
const tagAliases = { 抓牌: ['card-draw', 'draw'], draw: ['card-draw', 'draw'], 加速: ['mana-ramp', 'ramp'], ramp: ['mana-ramp', 'ramp'], 找地: ['tutor-land', 'land-tutor'], 单体去除: ['spot-removal'], 去除: ['removal', 'spot-removal'], 清场: ['sweeper', 'board-wipe'], boardwipe: ['sweeper', 'board-wipe'], 反击: ['counterspell', 'counter-ability'], 坟场互动: ['recursion', 'hate-graveyard', 'castable-from-graveyard', 'gives-castable-from-graveyard'] };
const colorAliases = { 白: 'w', 蓝: 'u', 黑: 'b', 红: 'r', 绿: 'g', white: 'w', blue: 'u', black: 'b', red: 'r', green: 'g', colorless: '', 无色: '', c: '' };
const rarityAliases = { 普通: 'common', 非普通: 'uncommon', 稀有: 'rare', 秘稀: 'mythic', c: 'common', u: 'uncommon', r: 'rare', m: 'mythic' };
const colors = 'wubrg';
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.zhName || a.name, b.zhName || b.name) || collator.compare(a.name, b.name) || String(a.id || '').localeCompare(String(b.id || ''));
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const rows = result => result?.results || [];
const number = value => ['string', 'number'].includes(typeof value) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(String(value).trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const mask = values => [...new Set((values || []).map(value => String(value).toLowerCase()))].reduce((value, color) => colors.includes(color) ? value | (1 << colors.indexOf(color)) : value, 0);
const facesOf = card => card.faces?.length ? card.faces : [card];
const translated = card => facesOf(card).filter(face => String(face.oracleText || '').trim()).every(face => String(face.zhText || '').trim());
const strip = (object, excluded) => Object.fromEntries(Object.entries(object).filter(([key]) => !excluded.includes(key)));
const pick = (object, included) => Object.fromEntries(included.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const valuesText = values => values.map(normalizeText).join('\n');
const json = value => JSON.stringify(value);
const safeVersion = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);

/** ASCII tokens encode Unicode bigrams; two-character Chinese queries stay indexed. */
export function searchGrams(value) {
  const chars = [...normalizeText(value)], tokens = new Set();
  const code = char => char.codePointAt(0).toString(16).padStart(6, '0');
  for (let i = 0; i < chars.length; i++) {
    tokens.add('u' + code(chars[i]));
    if (i) tokens.add('g' + code(chars[i - 1]) + code(chars[i]));
  }
  return [...tokens].join(' ');
}
function ftsQuery(value, field) {
  const chars = [...value];
  const tokens = chars.length < 2 ? searchGrams(value).split(' ') : searchGrams(value).split(' ').filter(token => token[0] === 'g');
  const column = { name: 'name_grams', o: 'oracle_grams', t: 'type_grams' }[field];
  return tokens.map(token => (column ? column + ' : ' : '') + '"' + token + '"').join(' AND ');
}
function typeTerms(value) {
  const line = normalizeText(value), found = new Set(line.split(/[\s—–～~／/]+/u).filter(token => /^[\p{Script=Han}]+$/u.test(token)));
  for (let start = 0; start < line.length; start++) {
    if (!/[a-z]/.test(line[start]) || start && /[a-z]/.test(line[start - 1])) continue;
    for (let end = start + 1; end <= line.length; end++) {
      const term = line.slice(start, end);
      if (!/^[a-z][a-z -]*$/.test(term)) break;
      if (!/[a-z]/.test(line[end] || '')) found.add(term);
    }
  }
  return [...found];
}

/** Build the complete snapshot name order once, before splitting import batches. */
export function buildNameRanks(cards) { return Object.fromEntries([...cards].sort(byName).map((card, index) => [card.id, index])); }

/** Normalized rows are serialized into JSON1, keeping each SQL statement at two bindings. */
export function normalizeCatalogBatch(cards, { metadata = null, nameRanks = null } = {}) {
  if (!Array.isArray(cards) || !cards.length || cards.length > 500) throw new Error('每批导入需要 1–500 张卡牌');
  const result = { cards: [], faces: [], printings: [], tags: [], types: [], fts: [] };
  const ids = new Set();
  for (const original of cards) {
    if (!plain(original) || typeof original.id !== 'string' || !original.id || typeof original.name !== 'string' || !original.name || !Array.isArray(original.faces) || !original.faces.length || ids.has(original.id)) throw new Error('导入卡牌格式无效或身份重复');
    ids.add(original.id);
    const extra = metadata?.cards?.[original.id];
    const card = { ...original, ...(extra ? { edhrecRank: extra.edhrecRank, faces: original.faces.map((face, i) => ({ ...face, power: extra.faces?.[i]?.power ?? null, toughness: extra.faces?.[i]?.toughness ?? null })) } : {}) };
    const faces = facesOf(card);
    const text = { name: valuesText([card.name, card.zhName, ...(card.aliases || []), ...faces.flatMap(face => [face.name, face.zhName])]), o: valuesText(faces.flatMap(face => [face.oracleText, face.zhText])), t: valuesText(faces.flatMap(face => [face.typeLine, face.zhTypeLine])) };
    const versions = card.versions?.length ? card.versions : [{ ...strip(card, ['faces', 'versions', 'tags', 'aliases']), id: card.id }];
    const defaultVersion = versions.find(version => version.id === card.defaultVersionId) || versions.find(version => version.set === card.set && String(version.collectorNumber) === String(card.collectorNumber) && (!card.lang || version.lang === card.lang)) || versions[0];
    const core = strip(card, ['versions', 'matchingVersions', 'matchingVersionIds', 'versionsComplete', 'nameRank']);
    core.defaultVersionId = defaultVersion.id;
    const usd = versions.map(printing => number(printing.usd)).filter(price => price !== null && price >= 0);
    if (usd.length) core.usd = Math.min(...usd);
    core.translationComplete = translated(card);
    const summary = { ...pick(core, ['id', 'name', 'zhName', 'manaCost', 'manaValue', 'colors', 'colorIdentity', 'typeLine', 'zhTypeLine', 'legalities', 'set', 'collectorNumber', 'defaultVersionId', 'releasedAt', 'image', 'layout', 'rarity', 'lang', 'edhrecRank']), faces: faces.map(face => pick(face, ['name', 'zhName', 'typeLine', 'zhTypeLine'])), translationComplete: core.translationComplete, ...(core.translation?.stale ? { translation: { stale: true } } : {}) };
    const nameRank = nameRanks?.[card.id] ?? card.nameRank;
    if (!Number.isSafeInteger(nameRank) || nameRank < 0) throw new Error('导入数据缺少全库名称排序序号');
    result.cards.push({ id: card.id, core: json(core), summary: json(summary), nameRank, manaValue: Number(card.manaValue ?? 0), colorMask: mask(card.colors), identityMask: mask(card.colorIdentity), commanderLegal: +(card.legalities?.commander === 'legal'), translated: +core.translationComplete, edhrecRank: Number.isInteger(card.edhrecRank) && card.edhrecRank > 0 ? card.edhrecRank : null, releasedAt: String(card.releasedAt || ''), nameText: text.name, oracleText: text.o, typeText: text.t, defaultVersionId: defaultVersion.id });
    faces.forEach((face, faceIndex) => {
      result.faces.push({ cardId: card.id, faceIndex, power: number(face.power), toughness: number(face.toughness), typeText: valuesText([face.typeLine, face.zhTypeLine]) });
      for (const term of new Set([face.typeLine, face.zhTypeLine].flatMap(typeTerms))) result.types.push({ cardId: card.id, faceIndex, term });
    });
    const printingIds = new Set();
    versions.forEach((version, ordinal) => {
      if (typeof version.id !== 'string' || !version.id || printingIds.has(version.id)) throw new Error('印刷版本身份无效或重复');
      printingIds.add(version.id);
      result.printings.push({ cardId: card.id, id: version.id, ordinal, setCode: normalizeText(version.set ?? card.set), collectorNumber: normalizeText(version.collectorNumber ?? card.collectorNumber), lang: normalizeText(version.lang ?? card.lang), rarity: normalizeText(version.rarity ?? card.rarity), payload: json(version.artist ? { ...version, artistSearch: normalizeText(version.artist) } : version) });
    });
    for (const slug of new Set((card.tags || []).map(tag => normalizeText(typeof tag === 'string' ? tag : tag.slug || tag.name)).filter(Boolean))) result.tags.push({ cardId: card.id, slug });
    result.fts.push({ cardId: card.id, name: searchGrams(text.name), oracle: searchGrams(text.o), type: searchGrams(text.t) });
  }
  return result;
}

function bindJSON(db, sql, values) { return db.prepare(sql).bind(json(values)); }
function parameterList(values) {
  // An independent scalar subquery is constant for the statement. Referencing
  // the outer qp alias inside FTS would rerun MATCH for every card.
  return { values, add(value) { const index = this.values.push(value) - 1; return `(SELECT json_extract(j,'$[${index}]') FROM qp)`; } };
}
const hasCharacteristic = node => node.type === 'term' ? ['pow', 'tou'].includes(node.field) : ['left', 'right', 'value'].some(key => node[key] && typeof node[key] === 'object' && hasCharacteristic(node[key]));
function colorMask(value) {
  const mapped = Object.hasOwn(colorAliases, value) ? colorAliases[value] : value.replace(/[白蓝黑红绿]/g, char => colorAliases[char]).replace(/[,，\s+]/g, '');
  return mask([...mapped]);
}
function comparison(actual, expected, op) { return `${actual} ${op === ':' ? '=' : op} ${expected}`; }

/** Compile only validated AST nodes; user text is always bound as JSON values. */
export function compileCatalogQuery(query = '', { sort = 'name', commanderOnly = false } = {}) {
  const error = validateSearch(query, { commanderOnly });
  if (error) throw new QueryError(error.message, error.position);
  const options = extractSearchOptions(query, sort), tree = parseQuery(options.query), faceMode = hasCharacteristic(tree), params = parameterList([]);
  let aliasIndex = 0, tagPosition = null;
  const cardUsd = "json_extract(c.core_json,'$.usd')";
  const printingUsd = alias => `json_extract(${alias}.payload_json,'$.usd')`;
  function expression(node, face = null, printing = 'v') {
    if (node.type === 'all') return '1';
    if (node.type === 'and' || node.type === 'or') return `(${expression(node.left, face, printing)} ${node.type.toUpperCase()} ${expression(node.right, face, printing)})`;
    if (node.type === 'not') {
      if (!faceMode) return `(NOT ${expression(node.value, face, printing)})`;
      const alias = `nf${++aliasIndex}`;
      return `(NOT EXISTS (SELECT 1 FROM catalog_faces ${alias} WHERE ${alias}.version=c.version AND ${alias}.card_id=c.id AND ${expression(node.value, alias, printing)}))`;
    }
    const { field, value, op } = node;
    if (['pow', 'tou'].includes(field)) return comparison(`${face}.${field === 'pow' ? 'power' : 'toughness'}`, params.add(Number(value)), op);
    if (field === 'cny') {
      const usd = tree.hasPrinting ? printingUsd(printing) : cardUsd;
      const cny = `(round(round(${usd}*100)*${CNY_FEN_PER_USD}/100.0)/100.0)`;
      return `coalesce(${comparison(cny, params.add(Number(value)), op)}, 0)`;
    }
    if (field === 'mv') return comparison('c.mana_value', params.add(Number(value)), op);
    if (field === 'c' || field === 'ci') {
      const actual = `c.${field === 'c' ? 'color_mask' : 'identity_mask'}`, expectedMask = colorMask(value), expected = params.add(expectedMask);
      if (op === '=') return `${actual}=${expected}`;
      if (op === '<=' || op === '<') return `((${actual} & ${expected})=${actual}${op === '<' ? ` AND ${actual}<>${expected}` : ''})`;
      if (op === '>' || op === '>=') return `((${actual} & ${expected})=${expected}${op === '>' ? ` AND ${actual}<>${expected}` : ''})`;
      return expectedMask ? `((${actual} & ${expected})=${expected})` : `${actual}=0`;
    }
    if (['all', 'name', 'o', 't'].includes(field)) {
      const needle = field === 't' ? typeAliases[value] || value : value;
      const column = field === 'all' ? '(c.name_text||char(10)||c.oracle_text||char(10)||c.type_text)' : field === 't' && face ? `${face}.type_text` : `c.${{ name: 'name_text', o: 'oracle_text', t: 'type_text' }[field]}`;
      if (op === '=') return `instr(char(10)||${column}||char(10),char(10)||${params.add(needle)}||char(10))>0`;
      if (field === 't' && (/^[a-z][a-z -]*$/.test(needle) || /^[\p{Script=Han}]+$/u.test(needle))) return `EXISTS (SELECT 1 FROM catalog_types ct WHERE ct.version=c.version AND ct.card_id=c.id${face ? ` AND ct.face_index=${face}.face_index` : ''} AND ct.term=${params.add(needle)})`;
      const recall = ftsQuery(needle, field);
      return `(${recall ? `c.rowid IN (SELECT rowid FROM catalog_fts WHERE catalog_fts MATCH ${params.add(recall)}) AND ` : ''}instr(${column},${params.add(needle)})>0)`;
    }
    if (field === 'm') {
      const cost = params.add(normalizeManaCost(value));
      const mana = "lower(replace(json_extract(mana_face.value,'$.manaCost'),' ',''))";
      return `EXISTS (SELECT 1 FROM json_each(c.core_json,'$.faces') mana_face WHERE ${op === '=' ? `${mana}=${cost}` : `instr(${mana},${cost})>0`})`;
    }
    if (field === 'a') {
      const artist = `coalesce(json_extract(${printing}.payload_json,'$.artistSearch'),'')`;
      const needle = params.add(value);
      return op === '=' ? `${artist}=${needle}` : `instr(${artist},${needle})>0`;
    }
    if (field === 'f') return 'c.commander_legal=1';
    if (field === 'is') return `c.translated=${value === 'translated' ? 1 : 0}`;
    if (field === 'tag') {
      tagPosition ??= node.position;
      const candidates = tagAliases[value] || localizedTagSlugs(value) || [value, value.replace(/ /g, '-')];
      return `EXISTS (SELECT 1 FROM catalog_tags tg WHERE tg.version=c.version AND tg.card_id=c.id AND tg.slug IN (SELECT value FROM json_each(${params.add(json(candidates))})))`;
    }
    const column = { set: 'set_code', cn: 'collector_number', lang: 'lang', r: 'rarity' }[field];
    return `${printing}.${column}=${params.add(field === 'r' ? rarityAliases[value] || value : value)}`;
  }
  // The printing subquery always evaluates the whole tree on the same version.
  const inner = faceMode ? `EXISTS (SELECT 1 FROM catalog_faces f WHERE f.version=c.version AND f.card_id=c.id AND ${expression(tree, 'f')})` : expression(tree);
  const predicate = `${commanderOnly ? 'c.commander_legal=1 AND ' : ''}${tree.hasPrinting ? `EXISTS (SELECT 1 FROM catalog_printings v WHERE v.version=c.version AND v.card_id=c.id AND ${inner})` : inner}`;
  const direction = options.descending ? 'DESC' : 'ASC';
  const sortByUsd = options.sort.startsWith('usd-');
  const price = sortByUsd || tree.hasCnyPrice ? (tree.hasPrinting
    ? `(SELECT MIN(${printingUsd('v')}) FROM catalog_printings v WHERE v.version=c.version AND v.card_id=c.id AND ${inner})`
    : cardUsd) : null;
  const orderBy = sortByUsd ? `(usd_price IS NULL) ASC,usd_price ${direction},c.name_rank ASC,c.id ASC` : options.sort.startsWith('mana-') ? `c.mana_value ${direction},c.name_rank ASC,c.id ASC` : options.sort === 'released' ? `c.released_at ${direction},c.name_rank ASC,c.id ASC` : options.sort === 'edhrec' ? `(c.edhrec_rank IS NULL) ASC,c.edhrec_rank ${direction},c.name_rank ASC,c.id ASC` : `c.name_rank ${direction},c.id ${direction}`;
  return { params: params.values, predicate, printingPredicate: inner, hasPrinting: tree.hasPrinting, tagPosition, orderBy, price, hasCnyPrice: tree.hasCnyPrice, options, prefix: 'WITH qp AS (SELECT ? AS j)' };
}

function checkedPage(value, fallback, maximum) { const parsed = value ?? fallback; if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new QueryError('分页参数无效'); return parsed; }
function distinctIds(ids) {
  if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new QueryError('卡牌列表无效，最多一次读取 500 张牌');
  return [...new Set(ids)];
}
function sanitizeMeta(meta) {
  const output = strip(plain(meta) ? meta : {}, ['shards', 'searchMetadata', 'tagVocabulary']);
  if (plain(meta?.searchMetadata)) output.searchMetadata = strip(meta.searchMetadata, ['url', 'bytes', 'sha256']);
  return output;
}
async function activeVersion(db) {
  const active = await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first();
  if (!active?.active_version) throw new Error('卡库正在准备，请稍后重试');
  return active.active_version;
}
function withVersions(card, versions, complete = false, matching = []) {
  const selected = new Map(versions.map(version => [version.id, version]));
  for (const version of matching) selected.set(version.id, version);
  return { ...card, versions: [...selected.values()], versionsComplete: complete, ...(matching.length ? { matchingVersions: matching } : {}) };
}

export function createCatalogService(db) {
  async function meta() {
    const found = await db.prepare('SELECT s.version,s.meta_json FROM catalog_snapshots s JOIN catalog_state a ON a.active_version=s.version AND a.id=1').first();
    if (!found) throw new Error('卡库正在准备，请稍后重试');
    return { ...sanitizeMeta(JSON.parse(found.meta_json)), datasetVersion: found.version };
  }
  async function hydrateCards(ids, { versions = [], full = false, summary = false, version: requestedSnapshot = null } = {}) {
    ids = distinctIds(ids);
    if (!ids.length) return [];
    const version = requestedSnapshot || await activeVersion(db);
    const found = rows(await db.prepare(`SELECT id,${summary ? "summary_json AS card_json,json_extract(core_json,'$.usd') AS min_usd" : 'core_json AS card_json'} FROM catalog_cards WHERE version=? AND id IN (SELECT value FROM json_each(?))`).bind(version, json(ids)).all());
    const requested = versions.filter(row => plain(row) && ids.includes(row.cardId) && typeof row.versionId === 'string').map(row => ({ cardId: row.cardId, versionId: row.versionId }));
    const printings = rows(await db.prepare(`SELECT p.card_id,p.payload_json FROM catalog_printings p JOIN catalog_cards c ON c.version=p.version AND c.id=p.card_id WHERE p.version=? AND p.card_id IN (SELECT value FROM json_each(?))${full ? '' : ' AND (p.id=c.default_version_id OR EXISTS (SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,\'$.cardId\')=p.card_id AND json_extract(r.value,\'$.versionId\')=p.id))'} ORDER BY p.ordinal`).bind(...(full ? [version, json(ids)] : [version, json(ids), json(requested)])).all());
    const byCard = new Map();
    for (const printing of printings) { const collection = byCard.get(printing.card_id) || []; collection.push(JSON.parse(printing.payload_json)); byCard.set(printing.card_id, collection); }
    const indexed = new Map(found.map(row => {
      const card = JSON.parse(row.card_json);
      if (summary) card.usd = row.min_usd;
      return [row.id, withVersions(card, byCard.get(row.id) || [], full)];
    }));
    return ids.map(id => indexed.get(id)).filter(Boolean);
  }
  async function batch(ids, options = {}) {
    const cards = await hydrateCards(ids, options), found = new Map(cards.map(card => [card.id, card]));
    return { cards, missingIds: distinctIds(ids).filter(id => !found.has(id)), missingVersions: (options.versions || []).filter(row => !found.get(row.cardId)?.versions.some(version => version.id === row.versionId)) };
  }
  async function detail(id) { return { card: (await hydrateCards([id], { full: true }))[0] || null }; }
  async function search({ q = '', query, sort = 'name', commanderOnly = false, offset = 0, limit = 48 } = {}, requestedSnapshot = null) {
    if (query !== undefined) q = query;
    try {
      offset = checkedPage(offset, 0, 1_000_000); limit = checkedPage(limit, 48, 100);
      if (!limit) throw new QueryError('每页至少显示一张牌');
      const compiled = compileCatalogQuery(q, { sort, commanderOnly });
      const version = requestedSnapshot || await activeVersion(db);
      if (compiled.tagPosition !== null && !await db.prepare('SELECT 1 AS found FROM catalog_tags WHERE version=? LIMIT 1').bind(version).first()) throw new QueryError('当前卡库尚未载入功能标签', compiled.tagPosition);
      // An independent scalar keeps the snapshot boundary indexable before scanning cards.
      const values = [...compiled.params, version], versionRef = `(SELECT json_extract(j,'$[${values.length - 1}]') FROM qp)`;
      const from = `FROM catalog_cards c CROSS JOIN qp WHERE c.version=${versionRef} AND ${compiled.predicate}`;
      const count = await bindJSON(db, `${compiled.prefix} SELECT COUNT(*) AS total ${from}`, values).first();
      const total = Number(count?.total || 0);
      const found = rows(await bindJSON(db, `${compiled.prefix} SELECT c.id${compiled.price ? `, ${compiled.price} AS usd_price` : ''} ${from} ORDER BY ${compiled.orderBy} LIMIT ${limit} OFFSET ${offset}`, values).all());
      const ids = found.map(row => row.id);
      let cards = await hydrateCards(ids, { summary: true, version });
      if (compiled.hasPrinting && ids.length) {
        const matched = rows(await bindJSON(db, `${compiled.prefix}, matching AS (SELECT v.card_id,v.id,v.payload_json,ROW_NUMBER() OVER (PARTITION BY v.card_id ORDER BY v.ordinal) AS position FROM catalog_printings v JOIN catalog_cards c ON c.version=v.version AND c.id=v.card_id CROSS JOIN qp WHERE c.version=${versionRef} AND c.id IN (SELECT value FROM json_each(${parameterList(values).add(json(ids))})) AND ${compiled.printingPredicate}) SELECT card_id,id,CASE WHEN position<=2 THEN payload_json END AS payload_json FROM matching ORDER BY card_id,position`, values).all());
        const byCard = new Map();
        for (const row of matched) { const entry = byCard.get(row.card_id) || { ids: [], versions: [] }; entry.ids.push(row.id); if (row.payload_json) entry.versions.push(JSON.parse(row.payload_json)); byCard.set(row.card_id, entry); }
        cards = cards.map(card => ({ ...withVersions(card, card.versions, false, byCard.get(card.id)?.versions || []), matchingVersionIds: byCard.get(card.id)?.ids || [] }));
      }
      if (compiled.price) {
        const prices = new Map(found.map(row => [row.id, row.usd_price]));
        cards = cards.map(card => {
          const usdPrice = prices.get(card.id) ?? null;
          return { ...card, usdPrice, ...(compiled.hasCnyPrice ? { cnyPrice: usdToCny(usdPrice) } : {}) };
        });
      }
      return { cards, total, offset, hasMore: offset + cards.length < total, error: null, datasetVersion: version };
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      return { cards: [], total: 0, offset, hasMore: false, error: { message: error.message, position: error.position } };
    }
  }
  async function suggest(q, identity = null, limit = 8) {
    const normalized = normalizeText(q);
    if (!normalized) return { cards: [], total: 0, error: null };
    limit = checkedPage(limit, 8, 50); if (!limit) throw new QueryError('候选数量无效');
    if (identity !== null && (!Array.isArray(identity) || identity.some(color => !/^[WUBRG]$/i.test(color)))) throw new QueryError('标识色无效');
    const version = await activeVersion(db);
    const identityMask = identity === null ? null : mask(identity);
    const tag = deckTagQuery(q);
    const scope = commanderScopeQuery(identity);
    if (tag) return search({ q: [tag, scope].filter(Boolean).join(' '), sort: 'edhrec', commanderOnly: true, limit }, version);
    const printing = normalized.match(/^([a-z0-9]+)\s*[:/#\s]\s*([a-z0-9★*\-]+)$/i);
    if (printing) {
      const [, set, collectorNumber] = printing;
      // Two-word card names also fit the printing syntax. Check the printing index before running a full printing search.
      const exists = await db.prepare(`
        SELECT 1 FROM catalog_printings p
        CROSS JOIN catalog_cards c ON c.version=p.version AND c.id=p.card_id
        WHERE p.version=?1 AND p.set_code=?2 AND p.collector_number=?3
          AND (?4 IS NULL OR (c.identity_mask & ?4)=c.identity_mask)
        LIMIT 1
      `).bind(version, set, collectorNumber, identityMask).first();
      if (exists) {
        return search({ q: [`set:"${set}" cn:"${collectorNumber}"`, scope].filter(Boolean).join(' '), limit }, version);
      }
    }
    // A prefix bounds the number of FTS terms. The full substring check removes false positives.
    const recall = ftsQuery([...normalized].slice(0, 32).join(''), 'name');
    const found = rows(await db.prepare(`
      WITH matches AS MATERIALIZED (
        SELECT c.rowid, c.id, c.name_rank,
          instr(char(10)||c.name_text||char(10), char(10)||?2||char(10))>0 AS is_exact
        FROM catalog_fts
        CROSS JOIN catalog_cards c ON c.rowid=catalog_fts.rowid
        WHERE catalog_fts MATCH ?1 AND c.version=?3
          AND (?4 IS NULL OR (c.identity_mask & ?4)=c.identity_mask)
          AND instr(c.name_text, ?2)>0
      ), stats AS (
        SELECT count(*) AS partial_total, sum(is_exact) AS exact_total FROM matches
      ), page AS (
        SELECT matches.rowid, matches.id, matches.name_rank,
          CASE WHEN stats.exact_total>0 THEN stats.exact_total ELSE stats.partial_total END AS total
        FROM matches CROSS JOIN stats
        WHERE matches.is_exact=(stats.exact_total>0)
        ORDER BY matches.name_rank, matches.id LIMIT ?5
      )
      SELECT page.total, c.summary_json, json_extract(c.core_json,'$.usd') AS min_usd, p.payload_json
      FROM page
      JOIN catalog_cards c ON c.rowid=page.rowid
      LEFT JOIN catalog_printings p ON p.version=c.version AND p.card_id=c.id AND p.id=c.default_version_id
      ORDER BY page.name_rank, page.id
    `).bind(recall, normalized, version, identityMask, limit).all());
    const cards = found.map(row => withVersions({ ...JSON.parse(row.summary_json), usd: row.min_usd }, row.payload_json ? [JSON.parse(row.payload_json)] : []));
    const total = found[0]?.total ?? 0;
    return { cards, total, offset: 0, hasMore: cards.length < total, error: null, datasetVersion: version };
  }
  async function resolveText(text) {
    const parsed = parseDeckText(text, []), names = [...new Set(parsed.rows.map(row => normalizeText(row.name)).filter(Boolean))];
    if (names.length > 2000) throw new QueryError('牌表最多解析 2000 个不同牌名');
    const ids = new Set(), version = await activeVersion(db);
    // Name resolution stays exact; no fuzzy candidate expansion or full-card scan in JS.
    for (let start = 0; start < names.length; start += 100) {
      const found = rows(await db.prepare(`SELECT c.id FROM catalog_cards c WHERE c.version=? AND EXISTS (SELECT 1 FROM json_each(?) n WHERE instr(char(10)||c.name_text||char(10),char(10)||n.value||char(10))>0)`).bind(version, json(names.slice(start, start + 100))).all());
      for (const row of found) ids.add(row.id);
    }
    const all = [];
    for (let start = 0, values = [...ids]; start < values.length; start += 500) all.push(...await hydrateCards(values.slice(start, start + 500), { full: true, version }));
    return { ...parseDeckText(text, all), cards: all };
  }
  return { meta, search, batch, detail, suggest, resolveText };
}

const rowSpecs = {
  cards: ['catalog_cards', { id: 'id', core_json: 'core', summary_json: 'summary', name_rank: 'nameRank', mana_value: 'manaValue', color_mask: 'colorMask', identity_mask: 'identityMask', commander_legal: 'commanderLegal', translated: 'translated', edhrec_rank: 'edhrecRank', released_at: 'releasedAt', name_text: 'nameText', oracle_text: 'oracleText', type_text: 'typeText', default_version_id: 'defaultVersionId' }],
  faces: ['catalog_faces', { card_id: 'cardId', face_index: 'faceIndex', power: 'power', toughness: 'toughness', type_text: 'typeText' }],
  printings: ['catalog_printings', { card_id: 'cardId', id: 'id', ordinal: 'ordinal', set_code: 'setCode', collector_number: 'collectorNumber', lang: 'lang', rarity: 'rarity', payload_json: 'payload' }],
  tags: ['catalog_tags', { card_id: 'cardId', slug: 'slug' }],
  types: ['catalog_types', { card_id: 'cardId', face_index: 'faceIndex', term: 'term' }],
};

export async function importCatalogBatch(db, { version, batchId, cards, metadata = null, nameRanks = null, meta = null, digest = '' }) {
  if (!safeVersion(version) || typeof batchId !== 'string' || !batchId || batchId.length > 128) throw new Error('卡库版本或批次编号无效');
  const existing = await db.prepare('SELECT digest,card_count FROM catalog_batches WHERE version=? AND batch_id=?').bind(version, batchId).first();
  if (existing) { if (digest && existing.digest !== digest) throw new Error('该批次已导入不同的数据'); return { imported: false, cards: existing.card_count, version, batchId }; }
  const state = await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first();
  if (state?.active_version === version) throw new Error('已启用的卡库版本不能修改');
  const data = normalizeCatalogBatch(cards, { metadata, nameRanks });
  const statements = [db.prepare(`INSERT INTO catalog_snapshots(version,meta_json,status) VALUES (?,?,'loading') ON CONFLICT(version) DO NOTHING`).bind(version, json(sanitizeMeta(meta)))];
  if (meta) statements.push(db.prepare(`UPDATE catalog_snapshots SET meta_json=? WHERE version=? AND status='loading'`).bind(json(sanitizeMeta(meta)), version));
  for (const [kind, [table, fields]] of Object.entries(rowSpecs)) {
    if (!data[kind].length) continue;
    statements.push(db.prepare(`INSERT INTO ${table}(version,${Object.keys(fields).join(',')}) SELECT ?,${Object.values(fields).map(field => `json_extract(value,'$.${field}')`).join(',')} FROM json_each(?)`).bind(version, json(data[kind])));
  }
  statements.push(db.prepare(`INSERT INTO catalog_fts(rowid,name_grams,oracle_grams,type_grams) SELECT c.rowid,json_extract(r.value,'$.name'),json_extract(r.value,'$.oracle'),json_extract(r.value,'$.type') FROM json_each(?) r CROSS JOIN catalog_cards c ON c.version=? AND c.id=json_extract(r.value,'$.cardId')`).bind(json(data.fts), version));
  statements.push(db.prepare('INSERT INTO catalog_batches(version,batch_id,digest,card_count) VALUES (?,?,?,?)').bind(version, batchId, digest, cards.length));
  await db.batch(statements);
  return { imported: true, cards: cards.length, version, batchId };
}

export async function activateCatalogVersion(db, { version, expectedCards, expectedFaces, expectedVersions, meta = null }) {
  if (!safeVersion(version)) throw new Error('卡库版本无效');
  const snapshot = await db.prepare('SELECT meta_json FROM catalog_snapshots WHERE version=?').bind(version).first();
  if (!snapshot) throw new Error('卡库版本尚未导入');
  const counts = {};
  for (const [kind, table] of [['cards', 'catalog_cards'], ['faces', 'catalog_faces'], ['versions', 'catalog_printings']]) counts[kind] = Number((await db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE version=?`).bind(version).first())?.total || 0);
  counts.indexedCards = Number((await db.prepare('SELECT COUNT(*) AS total FROM catalog_fts ft JOIN catalog_cards c ON c.rowid=ft.rowid WHERE c.version=?').bind(version).first())?.total || 0);
  for (const [name, expected] of [['cards', expectedCards], ['faces', expectedFaces], ['versions', expectedVersions]]) if (!Number.isSafeInteger(expected) || expected < 1 || counts[name] !== expected) throw new Error(`卡库 ${name} 数量不一致，尚未启用`);
  if (counts.indexedCards !== counts.cards) throw new Error('卡库检索索引数量不一致，尚未启用');
  const stored = sanitizeMeta({ ...JSON.parse(snapshot.meta_json), ...(meta || {}), counts: { cards: counts.cards, faces: counts.faces, versions: counts.versions } });
  await db.batch([
    db.prepare(`UPDATE catalog_snapshots SET status='retired' WHERE status='active' AND version<>?`).bind(version),
    db.prepare(`UPDATE catalog_snapshots SET status='active',meta_json=? WHERE version=?`).bind(json(stored), version),
    db.prepare('INSERT INTO catalog_state(id,active_version) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET active_version=excluded.active_version').bind(version),
  ]);
  return { version, counts, active: true };
}
