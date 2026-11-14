/** Local deck library. Card identities and printing IDs are stored separately. */
export const STORAGE_KEY = 'edh.deck-library.v1';
export const BACKUP_FORMAT = 'edh-deck-library';
export const ZONES = ['commander', 'main', 'considering'];
const MAX_QUANTITY = 999;
const clone = value => JSON.parse(JSON.stringify(value));
export const newId = () => globalThis.crypto?.randomUUID?.() || `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const now = () => new Date().toISOString();
const normalize = value => String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase();
const fail = message => { throw new Error(message); };
function str(value, label, max = 10000, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${label}格式不正确`);
  return value;
}
export function createDeck(name = '未命名卡组') {
  const timestamp = now();
  return { id: newId(), name: str(name.trim(), '卡组名称', 200, false), description: '', createdAt: timestamp, updatedAt: timestamp, customCategories: [], entries: [] };
}
function cardIndex(cards) { return new Map((cards || []).map(card => [card.id, card])); }
export function defaultVersion(card) {
  const versions = card.versions || [];
  return versions.find(version => version.id === card.defaultVersionId)?.id
    || versions.find(version => normalize(version.set) === normalize(card.set) && normalize(version.collectorNumber) === normalize(card.collectorNumber) && normalize(version.lang) === normalize(card.lang))?.id
    || versions[0]?.id || card.id;
}
export function getVersion(card, versionId) { return card?.versions?.find(version => version.id === versionId); }
function validateRecord(deck, cards) {
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) fail('卡组结构不正确');
  const customCategories = deck.customCategories ?? [];
  if (!Array.isArray(customCategories)) fail('个人分类格式不正确');
  const record = {
    id: str(deck.id, '卡组 ID', 200, false), name: str(deck.name, '卡组名称', 200, false),
    description: str(deck.description ?? '', '卡组说明'),
    createdAt: str(deck.createdAt, '创建时间', 100, false), updatedAt: str(deck.updatedAt, '修改时间', 100, false),
    customCategories: [...new Set(customCategories.map(category => str(category, '个人分类', 100, false).trim()))], entries: []
  };
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) fail('卡组时间格式不正确');
  if (!Array.isArray(deck.entries) || deck.entries.length > 10000) fail('卡组条目格式不正确或超过上限');
  const ids = new Set();
  const index = cards ? cardIndex(cards) : null;
  for (const [i, entry] of deck.entries.entries()) {
    if (!entry || typeof entry !== 'object') fail(`第 ${i + 1} 个条目格式不正确`);
    const clean = {
      id: str(entry.id, '条目 ID', 200, false), cardId: str(entry.cardId, '卡牌 ID', 200, false),
      versionId: str(entry.versionId, '印刷版本 ID', 200, false), quantity: entry.quantity, zone: entry.zone,
      categories: [], notes: str(entry.notes ?? '', '卡牌备注')
    };
    if (ids.has(clean.id)) fail('卡组中有重复的条目 ID');
    ids.add(clean.id);
    if (!Number.isInteger(clean.quantity) || clean.quantity < 1 || clean.quantity > MAX_QUANTITY) fail(`第 ${i + 1} 个条目的数量须为 1–${MAX_QUANTITY} 的整数`);
    if (!ZONES.includes(clean.zone)) fail(`第 ${i + 1} 个条目的分区不正确`);
    if (!Array.isArray(entry.categories) || entry.categories.length > 50) fail('个人分类格式不正确');
    clean.categories = [...new Set(entry.categories.map(category => str(category, '个人分类', 100, false)))];
    if (index) {
      const card = index.get(clean.cardId);
      if (!card) fail(`备份引用了当前卡库中缺失的卡牌：${clean.cardId}`);
      if (!getVersion(card, clean.versionId) && !(clean.versionId === card.id && !card.versions?.length)) fail(`备份引用了当前卡库中缺失的版本：${card.name} / ${clean.versionId}`);
    }
    record.entries.push(clean);
  }
  return record;
}
export function validateDeckLibrary(state) {
  if (state?.version !== 1 || !Array.isArray(state.decks) || !Array.isArray(state.trash)) fail('本地卡组数据格式不受支持');
  const ids = new Set();
  const decks = state.decks.map(deck => validateRecord(deck));
  const trash = state.trash.map(item => ({ deck: validateRecord(item.deck), deletedAt: str(item.deletedAt, '删除时间', 100, false) }));
  for (const deck of [...decks, ...trash.map(item => item.deck)]) {
    if (ids.has(deck.id)) fail('卡组 ID 重复');
    ids.add(deck.id);
  }
  return { version: 1, decks, trash };
}

export class DeckStore {
  constructor({ storage, key = STORAGE_KEY, onChange } = {}) {
    this.key = key;
    this.onChange = onChange;
    this.state = { version: 1, decks: [], trash: [] };
    this.status = { state: 'saved', message: '保存在此浏览器' };
    this.loadBlocked = false;
    this.recoveryRaw = null;
    let raw = null;
    try {
      this.storage = storage === undefined ? globalThis.localStorage : storage;
      if (!this.storage) fail('此环境无法使用浏览器本地存储');
      raw = this.storage.getItem(this.key);
      if (raw) this.state = validateDeckLibrary(JSON.parse(raw));
    } catch (error) {
      this.loadBlocked = true;
      this.recoveryRaw = raw;
      this.status = { state: 'error', message: `读取本地卡组失败：${error.message}。原始数据未被修改。` };
    }
  }
  list() { return clone(this.state.decks); }
  get(id) { const deck = this.state.decks.find(item => item.id === id); return deck ? clone(deck) : null; }
  deleted() { return clone(this.state.trash); }
  setSyncStorage(write) {
    this.writeSyncState = write;
  }
  replaceFromSync(next) {
    this.state = validateDeckLibrary(next);
  }
  commit(next) {
    const valid = validateDeckLibrary(next);
    try {
      if (this.loadBlocked) fail('原有数据未能读取，已暂停写入。请先导出原始数据，再使用恢复入口重建本地库');
      if (this.writeSyncState) this.writeSyncState(valid);
      else {
        if (!this.storage) fail('浏览器本地存储不可用');
        this.storage.setItem(this.key, JSON.stringify(valid));
      }
    } catch (error) {
      this.status = { state: 'error', message: `保存失败：${error.message}。请保留当前输入并检查浏览器存储空间或权限。` };
      this.onChange?.(this.status);
      throw new Error(this.status.message);
    }
    this.state = valid;
    this.status = { state: 'saved', message: `已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` };
    this.onChange?.(this.status);
    this.onCommit?.();
    return clone(valid);
  }
  rebuildAfterCorruption() {
    if (!this.loadBlocked || this.recoveryRaw === null) fail('当前没有可重建的损坏数据；请检查浏览器存储权限并重新加载');
    const recoveryKey = `${this.key}.recovery-${Date.now()}`;
    try { this.storage.setItem(recoveryKey, this.recoveryRaw); }
    catch (error) {
      this.status = { state: 'error', message: `无法保存原始恢复副本：${error.message}。原数据未修改。` };
      this.onChange?.(this.status); throw new Error(this.status.message);
    }
    this.loadBlocked = false;
    try { this.commit({ version: 1, decks: [], trash: [] }); }
    catch (error) { this.loadBlocked = true; throw error; }
    this.recoveryRaw = null;
    return recoveryKey;
  }
  create(name) { const deck = createDeck(name); this.commit({ ...this.state, decks: [...this.state.decks, deck] }); return deck; }
  save(deck) {
    const cleaned = validateRecord({ ...deck, updatedAt: now() });
    if (!this.state.decks.some(item => item.id === cleaned.id)) fail('卡组已不存在，请先刷新卡组库');
    this.commit({ ...this.state, decks: this.state.decks.map(item => item.id === cleaned.id ? cleaned : item) });
    return clone(cleaned);
  }
  copy(id) {
    const original = this.get(id);
    if (!original) fail('找不到要复制的卡组');
    const timestamp = now();
    const copied = { ...original, id: newId(), name: `${original.name} · 副本`, createdAt: timestamp, updatedAt: timestamp, entries: original.entries.map(entry => ({ ...entry, id: newId() })) };
    this.commit({ ...this.state, decks: [...this.state.decks, copied] });
    return clone(copied);
  }
  remove(id) {
    const deck = this.get(id);
    if (!deck) fail('找不到要删除的卡组');
    this.commit({ ...this.state, decks: this.state.decks.filter(item => item.id !== id), trash: [...this.state.trash, { deck, deletedAt: now() }] });
  }
  restore(id) {
    const item = this.state.trash.find(item => item.deck.id === id);
    if (!item) fail('找不到已删除的卡组');
    this.commit({ ...this.state, decks: [...this.state.decks, item.deck], trash: this.state.trash.filter(item => item.deck.id !== id) });
    return this.get(id);
  }
  addCard(deckId, card, versionId = defaultVersion(card), zone = 'main', quantity = 1, category = null) {
    const deck = this.get(deckId);
    if (!deck) fail('请先创建卡组');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) fail('数量须为 1–999 的整数');
    if (!ZONES.includes(zone)) fail('分区不正确');
    if (!getVersion(card, versionId) && !(versionId === card.id && !card.versions?.length)) fail('印刷版本不属于这张牌');
    const categories = category === null ? [] : [category];
    const matching = deck.entries.find(entry => entry.cardId === card.id && entry.versionId === versionId && entry.zone === zone && !entry.notes && entry.categories.length === categories.length && entry.categories[0] === categories[0]);
    if (matching) matching.quantity += quantity;
    else deck.entries.push({ id: newId(), cardId: card.id, versionId, quantity, zone, categories, notes: '' });
    return this.save(deck);
  }
  importBackup(text, { cards } = {}) {
    const parsed = parseDeckBackup(text, cards);
    const timestamp = now();
    const imported = parsed.decks.map(deck => ({ ...deck, id: newId(), createdAt: timestamp, updatedAt: timestamp, entries: deck.entries.map(entry => ({ ...entry, id: newId() })) }));
    this.commit({ ...this.state, decks: [...this.state.decks, ...imported] });
    return clone(imported);
  }
  importEntries(name, entries) {
    const deck = { ...createDeck(name), entries: entries.map(entry => ({ ...entry, id: newId() })) };
    this.commit({ ...this.state, decks: [...this.state.decks, validateRecord(deck)] });
    return clone(deck);
  }
}

export function exportDeckBackup(decks) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: now(), decks: decks.map(deck => validateRecord(deck)) }, null, 2);
}
export function parseDeckBackup(text, cards) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { fail('JSON 无法解析，请检查文件是否完整'); }
  if (data?.format !== BACKUP_FORMAT || data.version !== 1) fail('不支持的备份格式或版本');
  if (!Array.isArray(data.decks) || !data.decks.length || data.decks.length > 1000) fail('备份需包含 1–1000 套卡组');
  const decks = data.decks.map(deck => validateRecord(deck, cards));
  if (new Set(decks.map(deck => deck.id)).size !== decks.length) fail('备份有重复的卡组 ID');
  return { format: BACKUP_FORMAT, version: 1, decks };
}
function names(card) {
  return [card.name, card.zhName, ...(card.aliases || []), ...(card.faces || []).flatMap(face => [face.name, face.zhName])].filter(Boolean).map(normalize);
}
/** null leaves search unrestricted; [] explicitly represents a colorless commander. */
export function getCommanderIdentity(deck, cards) {
  const commanders = (deck.entries || []).filter(entry => entry.zone === 'commander');
  if (!commanders.length) return null;
  const index = cardIndex(cards);
  const identities = commanders.map(entry => index.get(entry.cardId)?.colorIdentity);
  if (identities.some(identity => !Array.isArray(identity))) return null;
  const colors = new Set(identities.flat().map(color => String(color).toUpperCase()));
  return ['W', 'U', 'B', 'R', 'G'].filter(color => colors.has(color));
}
export function findCardCandidates(query, cards, { exact = false, colorIdentity = null } = {}) {
  const q = normalize(query);
  if (!q) return [];
  if (colorIdentity !== null) {
    const allowed = new Set(colorIdentity.map(color => String(color).toUpperCase()));
    cards = cards.filter(card => Array.isArray(card.colorIdentity) && card.colorIdentity.every(color => allowed.has(String(color).toUpperCase())));
  }
  const printingQuery = q.match(/^([a-z0-9]+)\s*[:/#\s]\s*([a-z0-9★*\-]+)$/i);
  if (printingQuery) {
    const byPrinting = cards.filter(card => (card.versions || []).some(version => normalize(version.set) === printingQuery[1] && normalize(version.collectorNumber) === printingQuery[2]));
    if (byPrinting.length) return byPrinting;
  }
  const precise = cards.filter(card => names(card).includes(q));
  if (precise.length || exact) return precise;
  return cards.filter(card => names(card).some(name => name.includes(q))).slice(0, 50);
}
export function parseDeckText(text, cards) {
  if (typeof text !== 'string' || text.length > 2_000_000) fail('文本牌表过大或格式不正确');
  let zone = 'main';
  const rows = [];
  const headings = { commander: 'commander', commanders: 'commander', 统帅: 'commander', main: 'main', maindeck: 'main', deck: 'main', 主牌: 'main', considering: 'considering', maybeboard: 'considering', sideboard: 'considering', 候选牌: 'considering', 候选: 'considering' };
  for (const [offset, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const header = normalize(trimmed.replace(/^\[|\]$|:$/g, ''));
    if (headings[header]) { zone = headings[header]; continue; }
    const row = { line: offset + 1, raw, zone, status: 'error', message: '', candidates: [], quantity: 0, name: '', set: '', collectorNumber: '' };
    const match = trimmed.match(/^(\d+)[xX]?\s+(.+)$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1 || Number(match[1]) > MAX_QUANTITY) {
      row.message = '数量须为 1–999 的整数，格式：1 Sol Ring'; rows.push(row); continue;
    }
    row.quantity = Number(match[1]);
    const printing = match[2].match(/^(.*?)\s+\(([a-zA-Z0-9]+)\)\s+([^\s]+)\s*$/);
    row.name = (printing ? printing[1] : match[2]).trim();
    if (printing) { row.set = printing[2].toLowerCase(); row.collectorNumber = printing[3]; }
    row.candidates = findCardCandidates(row.name, cards, { exact: true }).map(card => card.id);
    if (!row.candidates.length) { row.status = 'unknown'; row.message = '未找到完全匹配的牌名'; }
    else if (row.candidates.length > 1) { row.status = 'ambiguous'; row.message = '牌名对应多张卡牌，请选择'; }
    else {
      const card = cards.find(item => item.id === row.candidates[0]);
      const version = printing ? (card.versions || []).find(item => normalize(item.set) === normalize(row.set) && normalize(item.collectorNumber) === normalize(row.collectorNumber)) : null;
      row.cardId = card.id;
      if (printing && !version) { row.status = 'version-missing'; row.message = '系列或编号未匹配，修改该行或明确使用默认版本'; }
      else { row.status = 'ready'; row.versionId = version?.id || defaultVersion(card); row.message = printing ? '已匹配牌名及版本' : '已匹配 · 默认版本'; }
    }
    rows.push(row);
  }
  return { rows, entries: rows.filter(row => row.status === 'ready').map(rowToEntry), errors: rows.filter(row => row.status !== 'ready') };
}
export function rowToEntry(row) {
  if (row.status !== 'ready' || !row.cardId || !row.versionId || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > MAX_QUANTITY) fail(`第 ${row.line} 行尚未解决`);
  return { id: newId(), cardId: row.cardId, versionId: row.versionId, quantity: row.quantity, zone: row.zone, categories: [], notes: '' };
}
export function exportDeckText(deck, cards, { chinese = false } = {}) {
  const index = cardIndex(cards);
  return ZONES.map(zone => {
    const header = { commander: 'Commander', main: 'Main', considering: 'Considering' }[zone];
    const lines = deck.entries.filter(entry => entry.zone === zone).map(entry => {
      const card = index.get(entry.cardId);
      if (!card) fail(`无法导出缺失卡牌：${entry.cardId}`);
      const version = getVersion(card, entry.versionId);
      return `${entry.quantity} ${chinese ? card.zhName || card.name : card.name}${version ? ` (${String(version.set).toUpperCase()}) ${version.collectorNumber}` : ''}`;
    });
    return `[${header}]\n${lines.join('\n')}`;
  }).join('\n\n');
}
function duplicateLimit(card) {
  if (/\bBasic\b/i.test(card.typeLine || card.faces?.[0]?.typeLine || '')) return Infinity;
  const text = [card.oracleText, ...(card.faces || []).map(face => face.oracleText)].join('\n');
  if (/a deck can have any number of cards named /i.test(text)) return Infinity;
  const limited = text.match(/a deck can have up to (\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) cards named /i);
  if (limited) return Number(limited[1]) || ({ two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 })[limited[1].toLowerCase()];
  return 1;
}
export function validateDeck(deck, cards) {
  const index = cardIndex(cards);
  const active = deck.entries.filter(entry => entry.zone !== 'considering');
  const commanders = active.filter(entry => entry.zone === 'commander');
  const count = active.reduce((sum, entry) => sum + entry.quantity, 0);
  const commanderCount = commanders.reduce((sum, entry) => sum + entry.quantity, 0);
  const consideringCount = deck.entries.filter(entry => entry.zone === 'considering').reduce((sum, entry) => sum + entry.quantity, 0);
  const issues = [];
  const issue = (code, severity, message, entryIds = []) => issues.push({ code, severity, message, entryIds });
  if (count !== 100) issue('count', 'error', `正式卡组共 ${count} 张，EDH 需要含统帅共 100 张`);
  if (!commanderCount) issue('commander-missing', 'error', '尚未设置统帅');
  if (commanderCount > 2) issue('commander-count', 'error', '统帅数量超过两张，请检查条目数量与组合规则');
  if (commanderCount > 1) issue('commander-combination', 'warning', '多统帅的搭档、背景及其他组合资格尚未校验，请人工核对');
  const colorIdentity = [...new Set(commanders.flatMap(entry => index.get(entry.cardId)?.colorIdentity || []))].sort();
  const counts = new Map();
  for (const entry of active) {
    const card = index.get(entry.cardId);
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > MAX_QUANTITY) issue('quantity', 'error', '有卡牌数量无效', [entry.id]);
    if (!card) { issue('missing-card', 'error', `当前卡库缺失卡牌：${entry.cardId}`, [entry.id]); continue; }
    const group = counts.get(card.id) || { card, quantity: 0, entries: [] };
    group.quantity += entry.quantity; group.entries.push(entry.id); counts.set(card.id, group);
    if (card.legalities?.commander === 'banned') issue('banned', 'error', `${card.zhName || card.name} 为 EDH 禁牌`, [entry.id]);
    else if (card.legalities?.commander === 'not_legal') issue('not-legal', 'error', `${card.zhName || card.name} 在 EDH 中不可用`, [entry.id]);
    if (commanderCount && card.colorIdentity?.some(color => !colorIdentity.includes(color))) issue('color-identity', 'error', `${card.zhName || card.name} 超出统帅标识色`, [entry.id]);
    if (entry.zone === 'commander') {
      const front = card.faces?.[0] || card;
      const type = front.typeLine || card.typeLine || '';
      const text = front.oracleText || card.oracleText || '';
      if (/can't be your commander/i.test(text)) issue('commander-ineligible', 'error', `${card.zhName || card.name} 的规则禁止用作统帅`, [entry.id]);
      else if (!(/\bLegendary\b/i.test(type) && /\bCreature\b/i.test(type)) && !/can be your commander\./i.test(text)) issue('commander-eligibility', 'warning', `${card.zhName || card.name} 的统帅资格尚未校验，请核对牌面及特殊规则`, [entry.id]);
    }
  }
  for (const { card, quantity, entries } of counts.values()) {
    const limit = duplicateLimit(card);
    if (quantity > limit) issue('duplicate', 'error', `${card.zhName || card.name} 共 ${quantity} 张，重复上限为 ${limit} 张（所有版本合计）`, entries);
  }
  return { count, mainCount: count - commanderCount, commanderCount, consideringCount, colorIdentity, issues, status: issues.some(item => item.severity === 'error') ? 'issues' : 'basic-checks-only' };
}
