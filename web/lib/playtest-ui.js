import { PlaytestSession, PLAYTEST_DEFAULTS, PLAYTEST_ZONES, PLAYTEST_BATTLEFIELD_ROWS, PLAYTEST_BATTLEFIELD_SLOTS } from './playtest.js';
import { PlaytestStorage } from './playtest-storage.js';
import { attachCardGestures } from './playtest-gestures.js';
import { createLibraryPanel } from './playtest-library.js';
import { createTokenPicker } from './playtest-token-picker.js';
import { getVersion } from './decks.js';

const ZONES = { hand: '手牌', battlefield: '战场', graveyard: '坟场', exile: '放逐区', command: '统帅区', library: '牌库', stack: '堆叠' };
const DOUBLE_FACED = new Set(['transform', 'modal_dfc', 'reversible_card', 'double_faced_token']);
function el(tag, cls = '', text) { const n = document.createElement(tag); n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function button(text, fn, cls = 'button button-quiet') { const n = el('button', cls, text); n.type = 'button'; n.addEventListener('click', fn); return n; }
function field(label, control) { const n = el('label', 'pt-field'); n.append(el('span', '', label), control); return n; }
function input(value = '', type = 'text') { const n = el('input', 'pt-input'); n.type = type; n.value = value; return n; }
function number(value, min, max, label) { const n = input(value, 'number'); n.min = min; n.max = max; n.step = '1'; if (label) n.setAttribute('aria-label', label); return n; }
function check(text, checked) { const control = input('', 'checkbox'); control.checked = checked; const label = el('label', 'pt-check'); label.append(control, el('span', '', text)); return { control, label }; }
function download(raw, name) { const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export function initPlaytestUI({ container, cards, onExit = () => {}, onNotify = () => {} }) {
  const index = new Map(cards.map(card => [card.id, card])), storage = new PlaytestStorage();
  let deck = null, session = null, savedSession = null, screen = 'setup', bottomIds = [], saveError = '', recoveryError = '', recoveryRaw = null;
  let layer = null, dialog = null, previousFocus = null, focusOrigin = null, counterName = '+1/+1', libraryQuery = '', peek = null;
  let boardLayer = 1;
  const boardOrder = new Map();
  let gestures = [], dialogGestures = [];
  const clean = list => { for (const cleanup of list.splice(0)) cleanup(); };
  const state = () => session.state;
  const zoneOf = (s, id) => PLAYTEST_ZONES.find(zone => s.zones[zone].includes(id));
  const cardOf = piece => piece.token ? piece : index.get(piece.cardId);
  function nameOf(piece) { const card = cardOf(piece), face = card?.faces?.[piece.inverted && card.layout === 'flip' ? 1 : piece.face]; return face?.zhName || face?.name || piece.name; }
  function imageOf(piece) { const card = cardOf(piece), version = getVersion(card, piece.versionId); return version?.faceImages?.[piece.face] || (piece.face ? card?.faces?.[piece.face]?.image : version?.image) || card?.faces?.[piece.face]?.image || card?.image; }
  function save() { try { storage.save(deck.id, session.export()); saveError = ''; } catch (error) { saveError = error.message; onNotify(error.message, 'error'); } }
  function act(action, { dismiss = false, restoreToPeek = false } = {}) {
    const previousBoard = action.type === 'token' ? new Set(state().zones.battlefield) : null;
    let s;
    try { s = session.dispatch(action); }
    catch (error) { onNotify(error.message, 'error'); return false; }
    bottomIds = bottomIds.filter(id => s.zones.hand.includes(id));
    for (const id of boardOrder.keys()) if (!s.battlefieldPositions[id]) boardOrder.delete(id);
    if (s.battlefieldPositions[action.id]) boardOrder.set(action.id, ++boardLayer);
    if (previousBoard) for (const id of s.zones.battlefield) {
      if (!previousBoard.has(id)) boardOrder.set(id, ++boardLayer);
    }
    if (action.type === 'shuffle') peek = null;
    if (peek) {
      const remaining = new Set(s.zones.library);
      for (const ids of [peek.ids, peek.bottom]) {
        for (const id of ids) if (!remaining.has(id)) ids.delete(id);
      }
      if (action.type === 'move' && action.to === 'library') {
        peek.ids.delete(action.id);
        if (action.position === 'bottom' && remaining.has(action.id)) peek.bottom.add(action.id);
        else peek.bottom.delete(action.id);
      }
      if (restoreToPeek) { peek.bottom.delete(action.id); peek.ids.add(action.id); }
    }
    if (dismiss) closeDialog({ restoreFocus: false });
    save(); render(); return true;
  }
  function disposeDialog() {
    clean(dialogGestures); const old = dialog; dialog = null;
    if (old) { old.close?.(); old.remove(); }
  }
  function closeDialog({ restoreFocus = true } = {}) {
    layer = null; disposeDialog();
    if (restoreFocus) {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else if (focusOrigin) {
        const card = Array.from(container.querySelectorAll?.('[data-piece-id]') || []).find(n => n.getAttribute('data-piece-id') === focusOrigin.id);
        card?.querySelector(focusOrigin.menu ? '.pt-card-menu' : '.pt-card-hit')?.focus({ preventScroll: true });
      }
    }
    previousFocus = null; focusOrigin = null;
  }
  function closeOverlays(options) {
    closeDialog(options);
    peek = null;
    container.querySelector('.pt-library-peek')?.remove();
  }
  function closePeek() {
    peek = null; render();
    container.querySelector('[data-library-title]')?.focus({ preventScroll: true });
  }
  function openLayer(next) {
    previousFocus = document.activeElement;
    focusOrigin = next.kind === 'card' ? { id: next.id, menu: previousFocus?.classList?.contains('pt-card-menu') } : null;
    layer = next; renderDialog();
  }
  function showCard(id) { counterName = '+1/+1'; openLayer({ kind: 'card', id }); }
  function moveCard(id, destination, { target, x } = {}) {
    const s = state();
    if (destination === 'library-peek') {
      if (!peek?.bottom.has(id)) return false;
      return act({ type: 'move', id, to: 'library', position: 'top' }, { restoreToPeek: true });
    }
    if (destination === 'hand-reorder' || destination === 'library-reorder') {
      const zone = destination === 'hand-reorder' ? 'hand' : 'library';
      const anchor = target?.getAttribute('data-piece-id');
      if (!anchor || anchor === id) return false;
      const restoreToPeek = zone === 'library' && peek?.bottom.has(id);
      if (zone === 'library' && (!peek?.ids.has(anchor) || !(peek.ids.has(id) || restoreToPeek))) return false;
      if (!s.zones[zone].includes(id)) return moveCard(id, zone);
      const rect = target.getBoundingClientRect();
      const key = x < rect.left + rect.width / 2 ? 'beforeId' : 'afterId';
      return act({ type: 'reorder', id, [key]: anchor }, { restoreToPeek });
    }
    if (destination === 'battlefield-slot' || destination === 'battlefield-row') {
      const row = target.getAttribute('data-row'), slot = target.getAttribute('data-slot');
      const action = { type: 'move', id, to: 'battlefield', row };
      if (slot !== null) action.slot = Number(slot);
      return act(action, { dismiss: true });
    }
    const to = destination.startsWith('library-') ? 'library' : destination;
    return act({ type: 'move', id, to, position: destination === 'library-top' ? 'top' : 'bottom' }, { dismiss: true });
  }
  function header() {
    const h = el('header', 'pt-heading'), title = el('div', 'pt-title');
    title.append(button('← 卡组', () => { closeOverlays(); onExit(); }, 'pt-back'), el('h1', '', deck.name));
    h.append(title);
    if (screen === 'table') h.append(button('设置', () => { closeOverlays(); savedSession = session; screen = 'setup'; render(); }));
    container.append(h);
  }
  function renderSaveError() {
    if (!saveError) return;
    const n = el('div', 'pt-save-error'); n.setAttribute('role', 'alert');
    n.append(el('span', '', saveError), button('重试保存', () => { save(); render(); })); container.append(n);
  }
  function begin(next) {
    closeOverlays();
    if (session !== next) { boardOrder.clear(); boardLayer = 1; }
    session = next; screen = 'table'; bottomIds = []; save(); render(); window.scrollTo?.({ top: 0, behavior: 'instant' });
  }
  function renderSetup() {
    const form = el('form', 'pt-setup'), defaults = session?.state.settings || PLAYTEST_DEFAULTS;
    const first = check('先手抓牌', defaults.drawFirstTurn); form.append(first.label);
    if (savedSession) {
      const old = savedSession.state, resume = el('section', 'pt-resume');
      resume.append(el('span', '', old.phase === 'opening' ? `调度 ${old.mulligans} 次 · ${old.zones.hand.length} 张手牌` : `第 ${old.turn} 回合 · ${old.life} 生命`), button('继续试牌', () => begin(savedSession), 'button button-primary')); form.append(resume);
    }
    let overwrite = null;
    if (recoveryError) {
      const error = el('section', 'pt-recovery'); error.setAttribute('role', 'alert'); error.append(el('strong', '', '旧测试进度无法恢复'), el('p', '', recoveryError));
      if (recoveryRaw !== null) error.append(button('下载原始进度', () => download(recoveryRaw, 'edh-playtest-recovery.json')));
      overwrite = check('覆盖旧测试进度', false); error.append(overwrite.label); form.append(error);
    }
    const error = el('p', 'pt-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const start = button(savedSession || recoveryError ? '重新开始' : '开始试牌', () => {}, 'button button-primary pt-start'); start.type = 'submit';
    if (overwrite) { start.disabled = true; overwrite.control.addEventListener('change', () => { start.disabled = !overwrite.control.checked; }); }
    form.append(error, start);
    form.addEventListener('submit', e => {
      e.preventDefault(); if (overwrite && !overwrite.control.checked) return;
      try { const next = new PlaytestSession(deck, cards, { drawFirstTurn: first.control.checked }); savedSession = null; recoveryError = ''; begin(next); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
    }); container.append(form);
  }
  function cardFace(piece, { large = false } = {}) {
    const face = el('span', 'pt-card-face'), url = imageOf(piece), name = nameOf(piece);
    face.append(el('span', 'pt-card-fallback', piece.token && !large ? '✦' : name));
    if (url && /^https?:\/\//i.test(url)) {
      const image = el('img'); image.src = url; image.alt = large ? name : ''; image.draggable = false; image.loading = large ? 'eager' : 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true }); face.append(image);
    }
    return face;
  }
  function tile(piece, s, zone, { cleanupList = gestures, compact = false, horizontal = false } = {}) {
    const opening = s.phase === 'opening', selected = bottomIds.indexOf(piece.id), name = nameOf(piece);
    const board = zone === 'battlefield';
    const card = el('article', `pt-card${board ? ' pt-card-board' : ''}${piece.tapped ? ' is-tapped' : ''}${piece.inverted ? ' is-inverted' : ''}${selected >= 0 ? ' is-bottom' : ''}${compact ? ' pt-card-compact' : ''}`);
    card.setAttribute('data-piece-id', piece.id); card.setAttribute('data-piece-zone', zone);
    if (!opening && zone === 'hand') card.setAttribute('data-drop-zone', 'hand-reorder');
    const selectBottom = opening && s.bottomRequired;
    const playFromHand = !opening && zone === 'hand';
    const playCommander = !opening && zone === 'command';
    const openCommand = playCommander && compact && s.zones.command.length > 1;
    const actionable = selectBottom || playFromHand || board || playCommander;
    const hit = actionable ? button('', () => {
      if (selectBottom) {
        const position = bottomIds.indexOf(piece.id);
        if (position >= 0) bottomIds.splice(position, 1);
        else if (bottomIds.length < s.bottomRequired) bottomIds.push(piece.id);
        else return;
        render();
      } else if (board) act({ type: 'tap', id: piece.id });
      else if (openCommand) openLayer({ kind: 'zone', zone: 'command' });
      else moveCard(piece.id, 'battlefield');
    }, 'pt-card-hit') : el('div', 'pt-card-hit');
    if (actionable) hit.setAttribute('aria-label', openCommand ? '查看统帅区' : `${selectBottom ? '选择沉底：' : board ? (piece.tapped ? '重置：' : '横置：') : '打出：'}${name}`);
    if (selectBottom) hit.setAttribute('aria-pressed', String(selected >= 0));
    const visual = el('span', 'pt-card-visual'); visual.append(cardFace(piece)); hit.append(visual, el('strong', 'pt-card-name', name));
    if (selected >= 0) hit.append(el('span', 'pt-bottom-badge', selected + 1));
    const counters = el('span', 'pt-card-counters');
    for (const [type, amount] of Object.entries(piece.counters)) counters.append(el('span', '', `${type} ${amount}`));
    const tokenFace = piece.token ? piece.faces?.[piece.face] || piece : null;
    if (tokenFace && (tokenFace.power || tokenFace.toughness)) counters.append(el('span', '', `${tokenFace.power || '?'}/${tokenFace.toughness || '?'}`));
    if (piece.tapped) counters.append(el('span', 'pt-tapped-label', '横置'));
    hit.append(counters); card.append(hit);
    if (!opening || !s.bottomRequired) {
      const menu = button('⋯', () => showCard(piece.id), 'pt-card-menu'); menu.setAttribute('aria-label', `${name}的操作`); card.append(menu);
    }
    if (!opening) cleanupList.push(attachCardGestures(card, { id: piece.id, zone, axis: horizontal || zone === 'hand' ? 'horizontal' : 'free', onDrop: moveCard }));
    return card;
  }
  function strip(s, zone, cls = 'pt-hand-row', cleanupList = gestures) {
    const row = el('div', cls); row.setAttribute('data-hand-scroll', ''); row.setAttribute('data-scroll-key', zone);
    for (const id of s.zones[zone]) row.append(tile(s.pieces[id], s, zone, { cleanupList })); return row;
  }
  function renderOpening(s) {
    const hand = el('section', 'pt-opening-hand'); hand.setAttribute('aria-label', '调度手牌');
    hand.append(el('h2', 'pt-zone-title', `手牌 · ${s.zones.hand.length}`), strip(s, 'hand'));
    const controls = el('div', 'pt-opening-controls'), info = el('div', 'pt-opening-count'); info.append(el('span', '', `调度 ${s.mulligans} 次`));
    if (s.bottomRequired) info.append(el('strong', 'pt-bottom-progress', `沉底 ${bottomIds.length}/${s.bottomRequired}`));
    const actions = el('div', 'pt-actions'), paid = Math.max(0, s.mulligans + 1 - s.settings.freeMulligans), possible = Math.min(s.settings.openingHandSize, s.zones.hand.length + s.zones.library.length);
    const mulligan = button(`重新调度${paid ? `（沉底 ${paid} 张）` : '（免费）'}`, () => { bottomIds = []; act({ type: 'mulligan' }); }); mulligan.disabled = paid > possible;
    const keep = button('保留并开始', () => { if (act({ type: 'keep', bottomIds })) window.scrollTo?.({ top: 0, behavior: 'instant' }); }, 'button button-primary'); keep.disabled = bottomIds.length !== s.bottomRequired;
    actions.append(mulligan, keep); controls.append(info, actions); hand.append(controls); container.append(hand);
  }
  function renderControls(s) {
    const bar = el('div', 'pt-controls'), life = el('div', 'pt-life'); life.append(el('span', 'pt-stat-label', '生命'), el('strong', '', s.life));
    for (const delta of [-5, -1, 1, 5]) { const b = button(delta > 0 ? `+${delta}` : `${delta}`, () => act({ type: 'life', delta }), 'pt-step'); b.setAttribute('aria-label', `生命${delta > 0 ? '增加' : '减少'}${Math.abs(delta)}`); life.append(b); }
    const turn = el('div', 'pt-turn'), actions = el('div', 'pt-turn-actions');
    const next = button('下一回合', () => act({ type: 'nextTurn' }), 'button button-primary pt-turn-button');
    const draw = el('form', 'pt-draw-form'), count = number(1, 1, 1000, '抓牌张数'), submit = button('抓牌', () => {}, 'button button-primary pt-turn-button');
    submit.type = 'submit'; draw.append(submit, count);
    draw.addEventListener('submit', e => { e.preventDefault(); act({ type: 'draw', count: Number(count.value) }); });
    actions.append(next, draw); turn.append(el('strong', '', `第 ${s.turn} 回合`), actions);
    const tools = el('div', 'pt-actions');
    tools.append(button('＋ 衍生物', () => openLayer({ kind: 'tokens' })));
    if (s.zones.stack.length) tools.append(button(`堆叠 ${s.zones.stack.length}`, () => openLayer({ kind: 'zone', zone: 'stack' })));
    bar.append(life, turn, tools); return bar;
  }
  function renderBattlefield(s) {
    const battlefield = el('section', 'pt-battlefield'); battlefield.setAttribute('data-drop-zone', 'battlefield'); battlefield.setAttribute('aria-label', '战场');
    battlefield.append(el('h2', 'pt-zone-title', `战场 · ${s.zones.battlefield.length}`));
    const rows = el('div', 'pt-battlefield-rows');
    rows.setAttribute('data-hand-scroll', ''); rows.setAttribute('data-scroll-key', 'battlefield');
    const positions = Object.fromEntries(PLAYTEST_BATTLEFIELD_ROWS.map(row => [row, new Map()]));
    for (const id of s.zones.battlefield) {
      const { row, slot } = s.battlefieldPositions[id];
      positions[row].set(slot, id);
    }
    for (const row of PLAYTEST_BATTLEFIELD_ROWS) {
      const section = el('div', 'pt-battlefield-row'), grid = el('div', 'pt-battlefield-cards');
      section.setAttribute('data-drop-zone', 'battlefield-row'); section.setAttribute('data-row', row);
      const slots = positions[row], count = Math.min(PLAYTEST_BATTLEFIELD_SLOTS, Math.max(4, Math.max(-1, ...slots.keys()) + 2));
      for (let slot = 0; slot < count; slot++) {
        const id = slots.get(slot), cell = el('div', `pt-board-slot${id ? '' : ' is-empty'}`);
        cell.setAttribute('data-drop-zone', 'battlefield-slot'); cell.setAttribute('data-row', row); cell.setAttribute('data-slot', slot);
        if (id) {
          cell.style.zIndex = String(boardOrder.get(id) || 1);
          cell.append(tile(s.pieces[id], s, 'battlefield', { horizontal: true }));
        }
        grid.append(cell);
      }
      section.append(grid); rows.append(section);
    }
    battlefield.append(rows);
    return battlefield;
  }
  function libraryPile(s) {
    const pile = el('section', 'pt-zone-pile pt-library-pile');
    pile.setAttribute('aria-label', '牌库'); pile.setAttribute('data-drop-zone', 'library-top');
    const title = button(`牌库 ${s.zones.library.length}`, () => openLayer({ kind: 'library', mode: 'menu' }), 'pt-pile-label');
    title.setAttribute('data-library-title', ''); title.setAttribute('aria-haspopup', 'dialog');
    const piece = s.showLibraryTop ? s.pieces[s.zones.library[0]] : null;
    const back = button('', () => act({ type: 'draw', count: 1 }), `pt-library-back${piece ? ' is-revealed' : ''}`);
    back.setAttribute('aria-label', piece ? `抓一张牌：${nameOf(piece)}` : '抓一张牌'); back.disabled = !s.zones.library.length;
    const front = el('span', 'pt-library-back-face');
    if (piece) front.append(cardFace(piece));
    back.append(front); pile.append(title, back);
    return pile;
  }
  function renderBoard(s) {
    const table = el('div', 'pt-table'); table.append(renderBattlefield(s));
    if (peek) {
      const bottomId = s.zones.library.at(-1);
      table.append(createLibraryPanel({
        mode: 'peek', ids: s.zones.library.filter(id => peek.ids.has(id)), bottomId: peek.bottom.has(bottomId) ? bottomId : null, cleanupList: gestures,
        cardTile: (id, options) => tile(s.pieces[id], s, 'library', options),
        onClose: closePeek,
      }));
    }
    const lower = el('div', 'pt-lower-table'), hand = el('section', 'pt-hand'); hand.setAttribute('data-drop-zone', 'hand'); hand.setAttribute('aria-label', '手牌'); hand.append(el('h2', 'pt-zone-title', `手牌 · ${s.zones.hand.length}`), strip(s, 'hand'));
    const piles = el('div', 'pt-zone-piles'); piles.append(libraryPile(s));
    for (const zone of ['graveyard', 'exile', 'command']) {
      const pile = el('section', 'pt-zone-pile'); pile.setAttribute('data-drop-zone', zone); pile.setAttribute('aria-label', ZONES[zone]);
      const open = button(`${ZONES[zone]} ${s.zones[zone].length}`, () => openLayer({ kind: 'zone', zone }), 'pt-pile-label'); pile.append(open);
      const id = s.zones[zone].at(-1);
      if (id) pile.append(tile(s.pieces[id], s, zone, { compact: true }));
      else { const empty = button('', () => openLayer({ kind: 'zone', zone }), 'pt-pile-empty'); empty.setAttribute('aria-label', `查看${ZONES[zone]}`); pile.append(empty); }
      piles.append(pile);
    }
    const handColumn = el('div', 'pt-hand-column'); handColumn.append(hand, renderControls(s));
    lower.append(handColumn, piles); table.append(lower); container.append(table);
  }
  function renderCardMenu(s, parent, id) {
    const piece = s.pieces[id]; if (!piece) return;
    const card = cardOf(piece), from = zoneOf(s, id), actions = el('div', 'pt-menu-actions');
    const preview = el('div', 'pt-card-preview'), image = el('div', `pt-preview-image${piece.inverted ? ' is-inverted' : ''}`);
    image.append(cardFace(piece, { large: true }));
    const rules = el('div', 'pt-preview-rules');
    const faces = card?.faces?.length ? card.faces : [card || piece];
    const current = piece.inverted && card?.layout === 'flip' ? 1 : piece.face;
    const order = faces[current] ? [faces[current], ...faces.filter((_, i) => i !== current)] : faces;
    for (const face of order) {
      const section = el('section');
      if (order.length > 1) section.append(el('h3', '', face.zhName || face.name));
      const type = face.zhTypeLine || face.typeLine;
      if (type) section.append(el('p', 'pt-preview-type', type));
      const ruleText = face.zhText || face.oracleText;
      if (ruleText) section.append(el('p', 'pt-preview-text', ruleText));
      rules.append(section);
    }
    preview.append(image, rules); parent.append(preview);
    if (s.phase === 'playing') {
      if (from === 'battlefield') actions.append(button(piece.tapped ? '重置' : '横置', () => act({ type: 'tap', id })));
      if (card?.layout === 'flip') actions.append(button('倒转', () => act({ type: 'invert', id })));
      else if (DOUBLE_FACED.has(card?.layout) && card.faces?.length > 1) actions.append(button('转化', () => act({ type: 'flip', id })));
    }
    if (actions.children.length) parent.append(actions);
    if (s.phase !== 'playing') return;
    if (from === 'battlefield') {
      const section = el('section', 'pt-counter-controls'), name = input(counterName); name.maxLength = 50; name.setAttribute('aria-label', '指示物名称');
      const row = el('div', 'pt-counter-stepper'), value = el('strong', '', piece.counters[counterName] || 0);
      const minus = button('−', () => { counterName = name.value.trim(); act({ type: 'counter', id, name: counterName, delta: -1 }); }, 'pt-step'); minus.setAttribute('aria-label', '减少指示物'); minus.disabled = !piece.counters[counterName];
      const plus = button('＋', () => { counterName = name.value.trim(); act({ type: 'counter', id, name: counterName, delta: 1 }); }, 'pt-step'); plus.setAttribute('aria-label', '增加指示物');
      name.addEventListener('input', () => { counterName = name.value; const key = counterName.trim(); value.textContent = piece.counters[key] || 0; minus.disabled = !piece.counters[key]; });
      row.append(minus, value, plus); section.append(field('计数器', name), row); parent.append(section);
      const types = Object.keys(piece.counters);
      if (types.length) { const choices = el('div', 'pt-counter-types'); for (const type of types) choices.append(button(`${type} · ${piece.counters[type]}`, () => { counterName = type; renderDialog(); })); parent.append(choices); }
    }
    const form = el('form', 'pt-move-form'), destination = el('select', 'pt-input'); destination.setAttribute('aria-label', '移动卡牌到');
    const options = Object.entries(ZONES).filter(([key]) => key !== 'library' && key !== from && (key !== 'stack' || s.zones.stack.length));
    options.push(['library-top', '牌库顶'], ['library-bottom', '牌库底']);
    for (const [key, label] of options) { const option = el('option', '', label); option.value = key; destination.append(option); }
    destination.value = options[0][0]; const move = button('移动', () => {}); move.type = 'submit'; form.append(field('移动到', destination), move); form.addEventListener('submit', e => { e.preventDefault(); moveCard(id, destination.value); }); parent.append(form);
    if (piece.token) parent.append(button('移除衍生物', () => act({ type: 'removeToken', id }, { dismiss: true }), 'button pt-danger'));
  }
  function renderZoneMenu(s, parent, zone) {
    const list = el('div', 'pt-zone-list'); list.setAttribute('data-hand-scroll', ''); list.setAttribute('data-scroll-key', `overlay-${zone}`);
    for (const id of s.zones[zone]) list.append(tile(s.pieces[id], s, zone, { cleanupList: dialogGestures, horizontal: true }));
    if (!s.zones[zone].length) list.append(el('p', 'pt-empty', '0 张'));
    parent.append(list);
  }
  function renderLibraryMenu(s, parent, mode) {
    parent.append(createLibraryPanel({
      mode, ids: s.zones.library, query: libraryQuery, showTop: s.showLibraryTop, cleanupList: dialogGestures,
      cardTile: (id, options) => tile(s.pieces[id], s, 'library', options),
      cardInfo: id => {
        const piece = s.pieces[id], card = index.get(piece.cardId), version = getVersion(card, piece.versionId);
        return { ...card, name: card?.name || piece.name, printedName: version?.printedName, set: version?.set, setName: version?.setName, collectorNumber: version?.collectorNumber };
      },
      onQueryChange: value => { libraryQuery = value; },
      onView: next => { layer = { kind: 'library', mode: next }; renderDialog(); dialog?.querySelector('[data-library-search]')?.focus({ preventScroll: true }); },
      onShowTop: value => act({ type: 'showLibraryTop', value }),
      onShuffle: () => act({ type: 'shuffle' }, { dismiss: true }),
      onPeek: count => {
        peek = { ids: new Set(s.zones.library.slice(0, count)), bottom: new Set() };
        closeDialog({ restoreFocus: false }); render();
        const shelf = container.querySelector('.pt-library-peek');
        shelf?.querySelector('button')?.focus({ preventScroll: true });
        shelf?.scrollIntoView?.({ block: 'center' });
      },
    }));
  }
  function renderTokenForm(parent) {
    const form = el('form', 'pt-token-form'), name = input('衍生物'), type = input('生物 — 衍生物'), power = input('1'), toughness = input('1'), quantity = number(1, 1, 50), create = button('创建', () => {}, 'button button-primary'); create.type = 'submit'; name.maxLength = 100; type.maxLength = 200; power.maxLength = toughness.maxLength = 20;
    form.append(field('名称', name), field('类别', type), field('力量', power), field('防御力', toughness), field('数量', quantity), create);
    form.addEventListener('submit', e => { e.preventDefault(); act({ type: 'token', name: name.value, typeLine: type.value, power: power.value, toughness: toughness.value, quantity: Number(quantity.value) }, { dismiss: true }); });
    const custom = el('details', 'pt-token-custom');
    custom.append(el('summary', '', '自定义衍生物'), form);
    parent.append(createTokenPicker(state(), (template, quantity) => act({ type: 'token', template, quantity }, { dismiss: true })), custom);
  }
  function renderDialog() {
    disposeDialog(); if (!layer || !session) return;
    const s = state(); if (layer.kind === 'card' && !s.pieces[layer.id]) { layer = null; return; }
    const kind = layer.kind, tray = kind === 'zone' || kind === 'library';
    const n = el('dialog', `pt-dialog ${tray ? 'pt-zone-dialog' : 'pt-card-dialog'}${kind === 'library' && layer.mode === 'menu' ? ' pt-library-options' : ''}`); dialog = n;
    const title = kind === 'card' ? nameOf(s.pieces[layer.id]) : tray ? `${ZONES[layer.zone || 'library']} · ${s.zones[layer.zone || 'library'].length}` : '创建衍生物';
    const heading = el('header', 'pt-dialog-heading'), h = el('h2', '', title); h.id = 'pt-dialog-title'; n.setAttribute('aria-labelledby', h.id);
    if (kind === 'library' && layer.mode !== 'menu') heading.append(button('← 牌库操作', () => { layer = { kind: 'library', mode: 'menu' }; renderDialog(); }));
    heading.append(h, button('关闭', () => closeDialog())); n.append(heading);
    if (kind === 'card') renderCardMenu(s, n, layer.id);
    else if (kind === 'zone') renderZoneMenu(s, n, layer.zone);
    else if (kind === 'library') renderLibraryMenu(s, n, layer.mode);
    else renderTokenForm(n);
    n.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); }); n.addEventListener('close', () => { if (dialog === n) closeDialog(); });
    n.addEventListener('click', e => { if (e.target !== n || tray) return; const r = n.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(); });
    container.append(n);
    // Zone trays stay non-modal so cards can be dragged back onto the table.
    if (tray) n.show?.(); else n.showModal?.();
  }
  function render() {
    const active = document.activeElement;
    const focusKey = dialog?.contains?.(active) ? active.getAttribute('aria-label') || active.textContent : null;
    const scrolls = new Map(Array.from(container.querySelectorAll?.('[data-scroll-key]') || [], n => [n.getAttribute('data-scroll-key'), [n.scrollLeft, n.scrollTop]]));
    disposeDialog(); clean(gestures); container.replaceChildren(); header();
    if (screen === 'setup') renderSetup();
    else { const s = state(); if (s.phase === 'opening') renderOpening(s); else renderBoard(s); renderSaveError(); }
    renderDialog();
    if (focusKey && dialog) {
      const controls = Array.from(dialog.querySelectorAll('button,input,select'));
      const next = controls.find(n => !n.disabled && (n.getAttribute('aria-label') || n.textContent) === focusKey)
        || (focusKey === '减少指示物' ? controls.find(n => n.getAttribute('aria-label') === '增加指示物') : null);
      next?.focus({ preventScroll: true });
    }
    for (const n of container.querySelectorAll?.('[data-scroll-key]') || []) { const position = scrolls.get(n.getAttribute('data-scroll-key')); if (position) { n.scrollLeft = position[0]; n.scrollTop = position[1]; } }
  }
  function open(nextDeck) {
    closeOverlays({ restoreFocus: false }); clean(gestures);
    const previous = session; deck = JSON.parse(JSON.stringify(nextDeck)); savedSession = previous?.state.deck.id === deck.id ? previous : null; session = savedSession; screen = 'setup'; bottomIds = []; libraryQuery = ''; saveError = ''; recoveryError = ''; recoveryRaw = null;
    if (!savedSession) { boardOrder.clear(); boardLayer = 1; }
    if (!savedSession) { try { const data = storage.load(deck.id); if (data) savedSession = PlaytestSession.restore(data, cards); } catch (error) { recoveryError = error.message; try { recoveryRaw = storage.raw(deck.id); } catch { /* Retain the recovery error. */ } } }
    render();
  }
  const onKeyDown = event => {
    if (event.key !== 'Escape' || document.body?.classList?.contains('pt-drag-active')) return;
    if (layer?.kind === 'zone' || layer?.kind === 'library') { event.preventDefault(); closeDialog(); }
    else if (!layer && peek) { event.preventDefault(); closePeek(); }
  };
  document.addEventListener?.('keydown', onKeyDown);
  return { open, closeOverlays, destroy() { closeOverlays({ restoreFocus: false }); clean(gestures); document.removeEventListener?.('keydown', onKeyDown); container.replaceChildren(); session = null; } };
}
