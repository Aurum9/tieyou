// Manual playtesting: card effects, payments and replacement effects stay with the player.
export const PLAYTEST_FORMAT = 'edh-playtest';
export const PLAYTEST_ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command', 'stack'];
export const PLAYTEST_BATTLEFIELD_ROWS = Object.freeze(['upper', 'lower']);
export const PLAYTEST_BATTLEFIELD_SLOTS = 1200;
export const PLAYTEST_DEFAULTS = Object.freeze({ openingHandSize: 7, startingLife: 40, freeMulligans: 1, drawFirstTurn: true, drawEachTurn: true, untapEachTurn: true });
const ZONE_NAMES = { library: '牌库', hand: '手牌', battlefield: '战场', graveyard: '坟场', exile: '放逐区', command: '统帅区', stack: '堆叠' };
const RESTORE = Symbol('restore');
const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uid = () => globalThis.crypto?.randomUUID?.() || `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
function str(value, label, max = 200) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}格式不正确`); return value; }
function int(value, label, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}须为 ${min}–${max} 的整数`); return value; }
const TOKEN_FACE_FIELDS = { zhName: 200, zhTypeLine: 200, oracleText: 4000, zhText: 4000, translationSource: 200, image: 500, power: 20, toughness: 20 };
function tokenFace(value) {
  if (!record(value)) fail('衍生物牌面无效');
  const face = { name: str(value.name, '衍生物名称'), typeLine: str(value.typeLine, '衍生物类别') };
  for (const [key, limit] of Object.entries(TOKEN_FACE_FIELDS)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > limit) fail('衍生物牌面无效');
    face[key] = value[key];
  }
  if (face.image && !/^https:\/\/[^/\s]+(?:\/|$)/i.test(face.image)) fail('衍生物牌图地址无效');
  if (value.colors !== undefined) {
    if (!Array.isArray(value.colors) || value.colors.length > 5) fail('衍生物颜色无效');
    const colors = [...value.colors];
    if (colors.some(color => !['W', 'U', 'B', 'R', 'G'].includes(color)) || new Set(colors).size !== colors.length) fail('衍生物颜色无效');
    face.colors = colors;
  }
  return face;
}
function tokenFromTemplate(template) {
  const { name: tokenName, ...face } = tokenFace(template);
  const result = { ...face, tokenName, name: face.zhName || tokenName, tokenTemplateId: str(template.id, '衍生物模板 ID') };
  if (template.printingId !== undefined) result.printingId = str(template.printingId, '衍生物版本 ID');
  if (template.layout !== undefined || template.faces !== undefined) {
    if (template.layout !== 'double_faced_token' || !Array.isArray(template.faces) || template.faces.length !== 2) fail('双面衍生物数据无效');
    result.layout = template.layout;
    result.faces = Array.from(template.faces, tokenFace);
  }
  return result;
}
function settingsFor(value = {}) {
  if (!record(value)) fail('测试设置格式不正确');
  const result = { ...PLAYTEST_DEFAULTS, ...value };
  int(result.openingHandSize, '起手张数', 1, 20); int(result.startingLife, '起始生命', 1, 9999); int(result.freeMulligans, '免费调度次数', 0, 10);
  for (const key of ['drawFirstTurn', 'drawEachTurn', 'untapEachTurn']) if (typeof result[key] !== 'boolean') fail('回合设置格式不正确');
  result.drawEachTurn = true; result.untapEachTurn = true;
  return Object.fromEntries(Object.keys(PLAYTEST_DEFAULTS).map(key => [key, result[key]]));
}
function snapshotDeck(deck, index) {
  if (!record(deck) || !Array.isArray(deck.entries) || deck.entries.length > 1000) fail('测试卡组格式不正确或条目过多');
  const result = { id: str(deck.id, '卡组 ID'), name: str(deck.name, '卡组名称'), updatedAt: String(deck.updatedAt || ''), entries: [] };
  let total = 0;
  for (const entry of deck.entries) {
    if (!record(entry) || !['main', 'commander', 'considering'].includes(entry.zone)) fail('卡组分区格式不正确');
    int(entry.quantity, '卡牌数量', 1, 999);
    if (entry.zone === 'considering') continue;
    const card = index.get(entry.cardId);
    if (!card) fail(`当前卡库缺少卡牌：${entry.cardId}`);
    const versionId = entry.versionId || card.defaultVersionId || card.versions?.[0]?.id || card.id;
    if (card.versions?.length && !card.versions.some(v => v.id === versionId)) fail(`当前卡库缺少印刷版本：${card.zhName || card.name}`);
    total += entry.quantity;
    if (total > 1000) fail('单次测试最多支持 1000 张正式卡牌');
    result.entries.push({ cardId: str(card.id, '卡牌 ID'), versionId: str(versionId, '版本 ID'), quantity: entry.quantity, zone: entry.zone });
  }
  if (!result.entries.some(entry => entry.zone === 'main')) fail('请先在主牌区加入卡牌，再开始测试');
  return result;
}
function shuffle(ids, random) {
  for (let i = ids.length - 1; i > 0; i--) {
    const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) fail('洗牌随机数无效');
    const j = Math.floor(value * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]];
  }
}
function log(state, text) { state.log.push({ id: uid(), text, turn: state.turn }); state.log = state.log.slice(-100); }
function draw(state, count) {
  const actual = Math.min(count, state.zones.library.length);
  state.zones.hand.push(...state.zones.library.splice(0, actual));
  log(state, actual < count ? `抓了 ${actual} 张牌（原计划 ${count} 张，牌库已空）` : `抓了 ${actual} 张牌`);
}
function locate(state, id) { const zone = PLAYTEST_ZONES.find(zone => state.zones[zone].includes(id)); if (!zone) fail('找不到这张测试牌'); return zone; }
function defaultBattlefieldRow(piece, card) {
  const face = card?.faces?.[piece.face] || card;
  const [types] = String(face?.typeLine || piece.typeLine || '').split(/[—–]/u, 1);
  if (/\bLand\b|(?:^|\s)(?:基本|传奇|傳奇|雪境)*地(?=\s|$)/u.test(types)) return 'lower';
  const tags = Array.isArray(card?.tags) ? card.tags : [];
  const manaRock = tags.some(tag => {
    const slug = typeof tag === 'string' ? tag : tag?.slug || tag?.name;
    return typeof slug === 'string' && /^mana[- ]?rock$/i.test(slug.trim());
  });
  return manaRock ? 'lower' : 'upper';
}
function validateBattlefieldRow(row) {
  if (!PLAYTEST_BATTLEFIELD_ROWS.includes(row)) fail('战场排无效');
}
function validateBattlefieldSlot(slot) { return int(slot, '战场格位', 0, PLAYTEST_BATTLEFIELD_SLOTS - 1); }
function placeOnBattlefield(state, id, card, { row, slot } = {}) {
  const positions = state.battlefieldPositions;
  const previous = Object.hasOwn(positions, id) ? positions[id] : null;
  if (previous && row === undefined && slot === undefined) return;
  if (row === undefined) row = previous?.row || defaultBattlefieldRow(state.pieces[id], card);
  validateBattlefieldRow(row);
  if (slot !== undefined) validateBattlefieldSlot(slot);
  const occupied = new Map();
  for (const [otherId, position] of Object.entries(positions)) {
    if (otherId !== id && position.row === row) occupied.set(position.slot, otherId);
  }
  if (slot !== undefined && occupied.has(slot) && previous) {
    positions[occupied.get(slot)] = previous;
  } else if (slot === undefined || occupied.has(slot)) {
    slot = 0;
    while (occupied.has(slot)) slot++;
    validateBattlefieldSlot(slot);
  }
  Object.defineProperty(positions, id, { value: { row, slot }, writable: true, enumerable: true, configurable: true });
}
function move(state, id, to, position = 'bottom', { row, slot, card } = {}) {
  if (!PLAYTEST_ZONES.includes(to)) fail('目标区域无效');
  if (!['top', 'bottom'].includes(position)) fail('牌库位置无效');
  const from = locate(state, id);
  if (to === 'battlefield') {
    placeOnBattlefield(state, id, card, { row, slot });
    if (from === to) return;
  } else {
    if (row !== undefined || slot !== undefined) fail('格位仅适用于战场');
    if (from === 'battlefield') delete state.battlefieldPositions[id];
  }
  const piece = state.pieces[id];
  state.zones[from].splice(state.zones[from].indexOf(id), 1);
  if (position === 'top') state.zones[to].unshift(id); else state.zones[to].push(id);
  if (from !== to) {
    piece.tapped = false; piece.inverted = false; piece.counters = {};
    if (!['battlefield', 'stack'].includes(to)) piece.face = 0;
  }
}

export class PlaytestSession {
  #state; #past = []; #future = []; #index; #random;
  constructor(deck, cards, settings = {}, { random = Math.random } = {}) {
    if (!Array.isArray(cards) || typeof random !== 'function') fail('卡库或随机数配置无效');
    this.#index = new Map(cards.map(card => [card.id, card])); this.#random = random;
    if (deck === RESTORE) return;
    const snapshot = snapshotDeck(deck, this.#index), options = settingsFor(settings);
    const state = { sessionId: uid(), deck: snapshot, settings: options, phase: 'opening', turn: 0, life: options.startingLife, mulligans: 0, bottomRequired: 0, landsPlayed: 0, landLimit: 1, zones: Object.fromEntries(PLAYTEST_ZONES.map(zone => [zone, []])), battlefieldPositions: {}, showLibraryTop: false, pieces: {}, log: [] };
    for (const entry of snapshot.entries) for (let i = 0; i < entry.quantity; i++) {
      const card = this.#index.get(entry.cardId), id = uid();
      state.pieces[id] = { id, cardId: card.id, versionId: entry.versionId, name: card.zhName || card.name || card.id, tapped: false, inverted: false, face: 0, counters: {}, token: false };
      state.zones[entry.zone === 'commander' ? 'command' : 'library'].push(id);
    }
    shuffle(state.zones.library, random); draw(state, options.openingHandSize); log(state, '开始试牌'); this.#state = state;
  }
  get state() { return clone(this.#state); }
  get canUndo() { return this.#past.length > 0; }
  get canRedo() { return this.#future.length > 0; }
  dispatch(action) {
    if (!record(action)) fail('测试操作格式不正确');
    const next = clone(this.#state);
    this.#apply(next, action);
    this.#past.push(this.#state); if (this.#past.length > 80) this.#past.shift();
    this.#state = next; this.#future = []; return this.state;
  }
  #apply(state, action) {
    const { type } = action;
    if (state.phase === 'opening') {
      if (type === 'mulligan') {
        const paid = Math.max(0, state.mulligans + 1 - state.settings.freeMulligans);
        const handSize = Math.min(state.settings.openingHandSize, state.zones.hand.length + state.zones.library.length);
        if (paid > handSize) fail('起手已无法继续调度');
        state.zones.library.push(...state.zones.hand.splice(0)); shuffle(state.zones.library, this.#random);
        state.mulligans++; state.bottomRequired = paid; draw(state, state.settings.openingHandSize);
        log(state, `第 ${state.mulligans} 次调度，保留时需沉底 ${paid} 张`); return;
      }
      if (type === 'keep') {
        const ids = action.bottomIds || [];
        if (!Array.isArray(ids) || ids.length !== state.bottomRequired || new Set(ids).size !== ids.length || ids.some(id => !state.zones.hand.includes(id))) fail(`请从手牌中选择恰好 ${state.bottomRequired} 张沉底`);
        for (const id of ids) move(state, id, 'library', 'bottom');
        state.phase = 'playing'; state.turn = 1; state.bottomRequired = 0; log(state, `保留起手，开始第 1 回合${ids.length ? `，${ids.length} 张牌按选择顺序沉底` : ''}`);
        if (state.settings.drawFirstTurn) draw(state, 1); return;
      }
      fail('请先保留起手，再进行回合操作');
    }
    if (type === 'mulligan' || type === 'keep') fail('起手阶段已经结束，可重开测试重新选择起手');
    if (type === 'draw') { draw(state, int(action.count ?? 1, '抓牌张数', 1, 1000)); return; }
    if (type === 'showLibraryTop') { if (typeof action.value !== 'boolean') fail('牌库顶显示设置无效'); state.showLibraryTop = action.value; return; }
    if (type === 'life') { int(action.delta, '生命变化', -9999, 9999); state.life = int(state.life + action.delta, '生命', -99999, 99999); log(state, `生命${action.delta >= 0 ? '+' : ''}${action.delta} → ${state.life}`); return; }
    if (type === 'setLandLimit') { state.landLimit = int(action.value, '本回合下地上限', 0, 99); log(state, `本回合下地上限设为 ${state.landLimit}`); return; }
    if (type === 'shuffle') { shuffle(state.zones.library, this.#random); log(state, '已洗牌库'); return; }
    if (type === 'nextTurn') {
      int(state.turn + 1, '回合数', 1, 99999); state.turn++; state.landsPlayed = 0; state.landLimit = 1;
      for (const id of state.zones.battlefield) state.pieces[id].tapped = false;
      log(state, `开始第 ${state.turn} 回合`); draw(state, 1); return;
    }
    if (type === 'token') {
      const quantity = int(action.quantity ?? 1, '衍生物数量', 1, 50);
      if (Object.keys(state.pieces).length + quantity > 1200) fail('测试牌张与衍生物总数已达上限');
      const details = action.template === undefined ? {
        name: str(action.name?.trim(), '衍生物名称', 100), typeLine: String(action.typeLine || '生物 — 衍生物').slice(0, 200),
        power: String(action.power ?? '').slice(0, 20), toughness: String(action.toughness ?? '').slice(0, 20),
      } : tokenFromTemplate(action.template);
      for (let i = 0; i < quantity; i++) {
        const id = uid();
        const piece = { id, cardId: null, versionId: null, ...details, tapped: false, inverted: false, face: 0, counters: {}, token: true };
        state.pieces[id] = piece;
        placeOnBattlefield(state, id, piece); state.zones.battlefield.push(id);
      }
      log(state, `创建 ${quantity} 个${details.name}衍生物`); return;
    }
    const id = str(action.id, '测试牌 ID'), piece = state.pieces[id];
    if (!piece) fail('找不到这张测试牌');
    const from = locate(state, id), card = piece.token && piece.tokenTemplateId ? piece : this.#index.get(piece.cardId), face = card?.faces?.[piece.face] || card;
    if (type === 'move') {
      move(state, id, action.to, action.position, { row: action.row, slot: action.slot, card });
      log(state, from === 'battlefield' && action.to === from ? `${piece.name}：调整战场位置` : `${piece.name}：${ZONE_NAMES[from]} → ${ZONE_NAMES[action.to]}${action.to === 'library' ? (action.position === 'top' ? '顶' : '底') : ''}`);
      return;
    }
    if (type === 'reorder') {
      if (!['hand', 'library'].includes(from)) fail('只有手牌和牌库支持重新排序');
      const after = action.afterId !== undefined;
      if (after === (action.beforeId !== undefined)) fail('请选择一个排序参照');
      const anchor = str(after ? action.afterId : action.beforeId, '排序参照'), ids = state.zones[from];
      if (anchor === id || !ids.includes(anchor)) fail('排序参照须为同一区域的另一张牌');
      ids.splice(ids.indexOf(id), 1); ids.splice(ids.indexOf(anchor) + Number(after), 0, id);
      log(state, `${piece.name}：调整${ZONE_NAMES[from]}顺序`); return;
    }
    if (type === 'cast') { if (!['hand', 'command'].includes(from) || piece.token || /\bLand\b/.test(face?.typeLine || '')) fail('请选择手牌或统帅区中当前牌面为非地的牌施放'); move(state, id, 'stack'); log(state, `施放 ${piece.name}`); return; }
    if (type === 'playLand') {
      if (from !== 'hand' || !/\bLand\b/.test(face?.typeLine || '') || piece.token) fail('请选择手牌中当前牌面为地的牌');
      move(state, id, 'battlefield', undefined, { card }); state.landsPlayed++; log(state, `下地：${piece.name}`); return;
    }
    if (type === 'tap') { if (from !== 'battlefield') fail('只有战场上的牌可以横置或重置'); if (action.tapped !== undefined && typeof action.tapped !== 'boolean') fail('横置状态无效'); piece.tapped = action.tapped ?? !piece.tapped; log(state, `${piece.tapped ? '横置' : '重置'} ${piece.name}`); return; }
    if (type === 'flip') { const count = card?.faces?.length || 1; if (count < 2) fail('这张牌没有其他牌面'); piece.face = (piece.face + 1) % count; log(state, `${piece.name}：切换至牌面 ${piece.face + 1}`); return; }
    if (type === 'invert') { if (card?.layout !== 'flip') fail('这张牌无法倒转'); piece.inverted = !piece.inverted; log(state, `${piece.inverted ? '倒转' : '还原'} ${piece.name}`); return; }
    if (type === 'counter') {
      if (from !== 'battlefield') fail('请选择战场上的牌设置指示物');
      const name = str(action.name?.trim(), '指示物名称', 50); if (['__proto__', 'constructor', 'prototype'].includes(name)) fail('指示物名称无效');
      if (!Object.hasOwn(piece.counters, name) && Object.keys(piece.counters).length >= 50) fail('单张牌最多支持 50 种指示物');
      const value = int((Object.hasOwn(piece.counters, name) ? piece.counters[name] : 0) + int(action.delta, '指示物变化', -999, 999), '指示物数量', 0, 999);
      if (value) piece.counters[name] = value; else delete piece.counters[name]; log(state, `${piece.name} 的 ${name} 指示物 → ${value}`); return;
    }
    if (type === 'removeToken') { if (!piece.token) fail('只有衍生物可以移除，实体牌请移动到相应区域'); state.zones[from].splice(state.zones[from].indexOf(id), 1); if (from === 'battlefield') delete state.battlefieldPositions[id]; delete state.pieces[id]; log(state, `移除 ${piece.name} 衍生物`); return; }
    fail('不支持此测试操作');
  }
  undo() { if (!this.canUndo) fail('没有可撤销的操作'); this.#future.push(this.#state); this.#state = this.#past.pop(); return this.state; }
  redo() { if (!this.canRedo) fail('没有可重做的操作'); this.#past.push(this.#state); this.#state = this.#future.pop(); return this.state; }
  export() {
    const result = { format: PLAYTEST_FORMAT, version: 1, state: this.state, past: clone(this.#past.slice(-12)), future: clone(this.#future.slice(-12)) };
    while (JSON.stringify(result).length > 1500000 && (result.past.length || result.future.length)) { if (result.past.length) result.past.shift(); else result.future.shift(); }
    return result;
  }
  static restore(data, cards, options = {}) {
    if (!record(data) || data.format !== PLAYTEST_FORMAT || data.version !== 1 || !Array.isArray(data.past) || !Array.isArray(data.future) || data.past.length > 80 || data.future.length > 80) fail('测试进度格式不受支持');
    const session = new PlaytestSession(RESTORE, cards, {}, options);
    const current = session.#validate(data.state);
    const validateHistory = state => { const clean = session.#validate(state); if (clean.sessionId !== current.sessionId || JSON.stringify(clean.deck) !== JSON.stringify(current.deck) || JSON.stringify(clean.settings) !== JSON.stringify(current.settings)) fail('测试历史与当前快照不一致'); return clean; };
    session.#state = current; session.#past = data.past.map(validateHistory); session.#future = data.future.map(validateHistory); return session;
  }
  #validate(value) {
    if (!record(value)) fail('测试状态损坏');
    const state = clone(value), snapshot = snapshotDeck(state.deck, this.#index); state.deck = snapshot; state.settings = settingsFor(state.settings);
    str(state.sessionId, '测试 ID');
    if (!['opening', 'playing'].includes(state.phase)) fail('测试阶段无效');
    int(state.turn, '回合数', 0, 99999); int(state.life, '生命', -99999, 99999); int(state.mulligans, '调度次数', 0, 30); int(state.bottomRequired, '沉底张数', 0, 20); int(state.landsPlayed, '下地次数', 0, 999); int(state.landLimit, '下地上限', 0, 99);
    if ((state.phase === 'opening' && (state.turn !== 0 || state.bottomRequired !== Math.max(0, state.mulligans - state.settings.freeMulligans))) || (state.phase === 'playing' && (state.turn < 1 || state.bottomRequired !== 0))) fail('测试阶段与回合不一致');
    if (!record(state.zones) || !record(state.pieces) || Object.keys(state.pieces).length > 1200 || !Array.isArray(state.log) || state.log.length > 100) fail('测试区域或记录损坏');
    const seen = new Set(), counts = new Map();
    for (const zone of PLAYTEST_ZONES) {
      if (!Array.isArray(state.zones[zone])) fail('测试区域损坏');
      for (const id of state.zones[zone]) { str(id, '测试牌 ID'); if (seen.has(id) || !Object.hasOwn(state.pieces, id)) fail('测试牌丢失或重复'); seen.add(id); }
    }
    if (seen.size !== Object.keys(state.pieces).length) fail('测试牌未放入区域');
    for (const [id, piece] of Object.entries(state.pieces)) {
      if (record(piece) && !Object.hasOwn(piece, 'inverted')) piece.inverted = false;
      if (!record(piece) || piece.id !== id || typeof piece.tapped !== 'boolean' || typeof piece.inverted !== 'boolean' || typeof piece.token !== 'boolean' || !record(piece.counters)) fail('测试牌状态损坏');
      str(piece.name, '测试牌名称'); int(piece.face, '牌面', 0, 20);
      if (piece.token) {
        if (piece.cardId !== null || piece.versionId !== null || piece.inverted) fail('衍生物数据损坏');
        if (Object.hasOwn(piece, 'tokenTemplateId')) {
          const template = tokenFromTemplate({ ...piece, id: piece.tokenTemplateId, name: piece.tokenName });
          if (piece.face >= (template.faces?.length || 1)) fail('衍生物牌面无效');
        } else if (piece.face !== 0) fail('衍生物数据损坏');
      }
      else {
        const card = this.#index.get(piece.cardId); if (!card || piece.face >= (card.faces?.length || 1)) fail('测试牌定义或牌面缺失');
        if (piece.inverted && card.layout !== 'flip') fail('倒转牌状态无效');
        const key = `${piece.cardId}\0${piece.versionId}`; counts.set(key, (counts.get(key) || 0) + 1);
      }
      if (Object.keys(piece.counters).length > 50) fail('指示物种类过多');
      for (const [name, value] of Object.entries(piece.counters)) { str(name, '指示物名称', 50); if (['__proto__', 'constructor', 'prototype'].includes(name)) fail('指示物名称无效'); int(value, '指示物数量', 1, 999); }
    }
    const expected = new Map(); for (const entry of snapshot.entries) { const key = `${entry.cardId}\0${entry.versionId}`; expected.set(key, (expected.get(key) || 0) + entry.quantity); }
    if (counts.size !== expected.size || [...expected].some(([key, value]) => counts.get(key) !== value)) fail('测试牌张与原始快照不一致');
    const battlefield = state.zones.battlefield;
    if (!Object.hasOwn(state, 'battlefieldPositions')) {
      state.battlefieldPositions = {};
      for (const id of battlefield) placeOnBattlefield(state, id, this.#index.get(state.pieces[id].cardId));
    } else {
      const positions = state.battlefieldPositions, occupied = new Set();
      if (!record(positions) || Object.keys(positions).length !== battlefield.length) fail('战场位置损坏');
      for (const id of battlefield) {
        const position = positions[id];
        if (!Object.hasOwn(positions, id) || !record(position)) fail('战场位置损坏');
        validateBattlefieldRow(position.row); validateBattlefieldSlot(position.slot);
        const key = `${position.row}:${position.slot}`;
        if (occupied.has(key)) fail('战场格位重复');
        occupied.add(key);
      }
    }
    if (!Object.hasOwn(state, 'showLibraryTop')) state.showLibraryTop = false;
    if (typeof state.showLibraryTop !== 'boolean') fail('牌库顶显示设置无效');
    if (state.phase === 'opening' && state.bottomRequired > state.zones.hand.length) fail('调度沉底数量无效');
    for (const entry of state.log) { if (!record(entry)) fail('操作记录损坏'); str(entry.id, '记录 ID'); str(entry.text, '操作记录', 1000); int(entry.turn, '记录回合', 0, 99999); }
    return state;
  }
}
