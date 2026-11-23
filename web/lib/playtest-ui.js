import { PlaytestSession, PLAYTEST_DEFAULTS, PLAYTEST_ZONES, PLAYTEST_BATTLEFIELD_ROWS, PLAYTEST_BATTLEFIELD_SLOTS } from './playtest.js';
import { PlaytestStorage } from './playtest-storage.js';
import { attachCardGestures } from './playtest-gestures.js';
import { createLibraryPanel } from './playtest-library.js';
import { createTokenPicker } from './playtest-token-picker.js';
import { getVersion } from './decks.js';
import { appendManaText } from './mana-symbols.js';
import { matchesPlaytestType, playtestTypeOptions } from './playtest-batch.js';
import { createDeckProbability } from './deck-probability-ui.js';
import { battlefieldPoint, snappedBattlefieldPoint, handCardGap } from './playtest-layout.js';

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
  let analysisPanel = null, analysisController = null, analysisOpen = false;
  const typeOptions = playtestTypeOptions(cards);
  const boardOrder = new Map();
  let gestures = [], dialogGestures = [];
  let tableObserver = null;
  let overflowTools = [];
  const clean = list => { for (const cleanup of list.splice(0)) cleanup(); };
  const state = () => session.state;
  const zoneOf = (s, id) => PLAYTEST_ZONES.find(zone => s.zones[zone].includes(id));
  const cardOf = piece => piece.token ? piece : index.get(piece.cardId);
  function nameOf(piece) { const card = cardOf(piece), face = card?.faces?.[piece.inverted && card.layout === 'flip' ? 1 : piece.face]; return face?.zhName || face?.name || piece.name; }
  function imageOf(piece) { const card = cardOf(piece), version = getVersion(card, piece.versionId); return version?.faceImages?.[piece.face] || (piece.face ? card?.faces?.[piece.face]?.image : version?.image) || card?.faces?.[piece.face]?.image || card?.image; }
  function save() { try { storage.save(deck.id, session.export()); saveError = ''; } catch (error) { saveError = error.message; onNotify(error.message, 'error'); } }
  function act(action, { dismiss = false, restoreToPeek = false } = {}) {
    const previousBoard = ['token', 'batchMove'].includes(action.type) ? new Set(state().zones.battlefield) : null;
    let s;
    try { s = session.dispatch(action); }
    catch (error) { onNotify(error.message, 'error'); return false; }
    bottomIds = bottomIds.filter(id => s.zones.hand.includes(id));
    for (const id of boardOrder.keys()) if (!s.battlefieldPositions[id]) boardOrder.delete(id);
    if (s.battlefieldPositions[action.id]) boardOrder.set(action.id, ++boardLayer);
    if (previousBoard) for (const id of s.zones.battlefield) {
      if (!previousBoard.has(id)) boardOrder.set(id, ++boardLayer);
    }
    if (action.type === 'shuffle' || action.type === 'batchMove' && (action.from === 'library' || action.to === 'library')) peek = null;
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
  function moveCard(id, destination, { target, x, y, offsetX, offsetY } = {}) {
    const s = state();
    if (destination === 'battlefield-free') {
      const canvas = target.closest('.pt-battlefield-canvas'), rect = canvas.getBoundingClientRect();
      const existing = canvas.querySelector('.pt-free-card'), sample = existing || el('div', 'pt-free-card');
      if (!existing) canvas.append(sample);
      const bounds = sample.getBoundingClientRect(), width = bounds.width, height = bounds.height;
      if (!existing) sample.remove();
      const point = snappedBattlefieldPoint(x - rect.left - (offsetX ?? width / 2), y - rect.top - (offsetY ?? height / 2), rect.width, rect.height, width, height);
      return act({ type: 'move', id, to: 'battlefield', ...point }, { dismiss: true });
    }
    if (destination === 'library-peek') {
      const restoreToPeek = peek?.bottom.has(id);
      if (!restoreToPeek && !peek?.ids.has(id)) return false;
      const afterId = s.zones.library.findLast(cardId => peek.ids.has(cardId));
      if (afterId === id) return false;
      if (afterId) return act({ type: 'reorder', id, afterId }, { restoreToPeek });
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
    container.append(h);
  }
  function renderSaveError() {
    if (!saveError) return;
    const n = el('div', 'pt-save-error'); n.setAttribute('role', 'alert');
    n.append(el('span', '', saveError), button('重试保存', () => { save(); render(); })); container.append(n);
  }
  function begin(next) {
    closeOverlays();
    if (session !== next) { boardOrder.clear(); boardLayer = 1; resetAnalysis(); }
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
      else {
        const source = cardOf(piece), face = source?.faces?.[piece.face] || source;
        const spell = playFromHand && /\b(?:Instant|Sorcery)\b|瞬间|法术/.test(String(face?.typeLine || source?.typeLine || '').split(/[—–～]/)[0]);
        moveCard(piece.id, spell ? 'graveyard' : 'battlefield');
      }
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
    if (!opening) cleanupList.push(attachCardGestures(card, { id: piece.id, zone, axis: !board && (horizontal || zone === 'hand') ? 'horizontal' : 'free', onDrop: moveCard }));
    return card;
  }
  function strip(s, zone, cls = 'pt-hand-row', cleanupList = gestures) {
    const row = el('div', cls); row.setAttribute('data-hand-scroll', ''); row.setAttribute('data-scroll-key', zone);
    for (const id of s.zones[zone]) row.append(tile(s.pieces[id], s, zone, { cleanupList })); return row;
  }
  function renderOpening(s) {
    const hand = el('section', 'pt-opening-hand'); hand.setAttribute('aria-label', '调度手牌');
    const row = strip(s, 'hand');
    const count = s.zones.hand.length, firstLine = count <= 4 ? count : Math.floor(count / 2);
    const secondLine = count - firstLine, columns = Math.max(1, firstLine, secondLine), lines = secondLine ? 2 : 1;
    row.style.gridTemplateColumns = `repeat(${columns * 2}, minmax(0, 1fr))`;
    row.style.gridTemplateRows = `repeat(${lines}, auto)`;
    for (const [i, card] of Array.from(row.children).entries()) {
      const lower = i >= firstLine, lineCount = lower ? secondLine : firstLine, position = lower ? i - firstLine : i;
      card.style.gridRow = lower ? '2' : '1';
      card.style.gridColumn = `${columns - lineCount + 1 + position * 2} / span 2`;
    }
    hand.append(el('h2', 'pt-zone-title', `手牌 · ${s.zones.hand.length}`), row);
    const mini = el('div', 'pt-hand-mini'); mini.setAttribute('aria-label', '手牌缩略导航');
    const thumbnails = el('div', 'pt-mini-cards'), viewport = el('span', 'pt-mini-viewport');
    viewport.setAttribute('aria-hidden', 'true');
    for (const id of s.zones.hand) {
      const thumb = button('', () => {}, `pt-mini-card${bottomIds.includes(id) ? ' is-bottom' : ''}`);
      thumb.setAttribute('aria-label', `定位手牌：${nameOf(s.pieces[id])}`);
      thumb.append(cardFace(s.pieces[id])); thumbnails.append(thumb);
      thumb.addEventListener('click', event => {
        if (miniMoved) { event.preventDefault(); return; }
        const card = row.querySelector(`[data-piece-id="${id}"]`);
        row.scrollTo({ left: card.offsetLeft - row.offsetLeft - (row.clientWidth - card.offsetWidth) / 2, behavior: 'smooth' });
      });
    }
    mini.append(thumbnails, viewport); hand.append(mini);
    function syncMini() {
      const ratio = Math.min(1, row.clientWidth / Math.max(1, row.scrollWidth));
      viewport.style.width = `${ratio * 100}%`;
      viewport.style.left = `${row.scrollLeft / Math.max(1, row.scrollWidth) * 100}%`;
      container.style.setProperty('--pt-opening-fit', `${Math.max(24, Math.floor(((row.clientHeight - 24 - (lines - 1) * 8) / lines - 24) * 488 / 680))}px`);
      layoutTable();
    }
    let miniPointer = null, miniStart = 0, miniMoved = false;
    const scrub = event => {
      const r = mini.getBoundingClientRect(), ratio = (event.clientX - r.left) / r.width;
      row.scrollLeft = ratio * row.scrollWidth - row.clientWidth / 2; syncMini();
    };
    mini.addEventListener('pointerdown', event => { miniPointer = event.pointerId; miniStart = event.clientX; miniMoved = false; });
    mini.addEventListener('pointermove', event => {
      if (miniPointer !== event.pointerId || !(miniMoved || Math.abs(event.clientX - miniStart) > 4)) return;
      if (!miniMoved) mini.setPointerCapture(event.pointerId);
      miniMoved = true; scrub(event);
    });
    for (const name of ['pointerup', 'pointercancel']) mini.addEventListener(name, () => { miniPointer = null; });
    mini.addEventListener('lostpointercapture', event => { if (event.target === mini) miniPointer = null; });
    row.addEventListener('scroll', syncMini, { passive: true });
    if (typeof ResizeObserver === 'function') { const resize = new ResizeObserver(syncMini); resize.observe(row); gestures.push(() => resize.disconnect()); }
    const controls = el('div', 'pt-opening-controls'), info = el('div', 'pt-opening-count'); info.append(el('span', '', `调度 ${s.mulligans} 次`));
    if (s.bottomRequired) {
      const progress = el('strong', 'pt-bottom-progress', `请选择 ${s.bottomRequired} 张牌置于牌库底 · ${bottomIds.length}/${s.bottomRequired}`);
      progress.setAttribute('role', 'status'); info.append(progress);
    }
    const actions = el('div', 'pt-actions'), paid = Math.max(0, s.mulligans + 1 - s.settings.freeMulligans), possible = Math.min(s.settings.openingHandSize, s.zones.hand.length + s.zones.library.length);
    const mulligan = button('调度', () => { bottomIds = []; act({ type: 'mulligan' }); }); mulligan.disabled = paid > possible;
    const keep = button(s.bottomRequired ? '沉底并保留' : '保留', () => { if (act({ type: 'keep', bottomIds })) { resetAnalysis(); window.scrollTo?.({ top: 0, behavior: 'instant' }); } }, 'button button-primary'); keep.disabled = bottomIds.length !== s.bottomRequired;
    actions.append(mulligan, keep, button('更多 ⋯', () => openLayer({ kind: 'tools' }), 'button button-quiet pt-more')); controls.append(info, actions); hand.append(controls);
    const analysis = el('details', 'pt-opening-analysis'); analysis.open = analysisOpen;
    analysis.append(el('summary', '', '起手分析'));
    const body = el('div', 'pt-opening-analysis-body'); analysis.append(body);
    const mountAnalysis = () => {
      if (!analysisPanel) {
        analysisController = new AbortController();
        analysisPanel = createDeckProbability(s.deck, cards, { signal: analysisController.signal, drawFirstTurn: s.settings.drawFirstTurn });
      }
      body.append(analysisPanel);
    };
    if (analysisOpen) mountAnalysis();
    analysis.addEventListener('toggle', () => { if (!analysis.isConnected) return; analysisOpen = analysis.open; if (analysisOpen) mountAnalysis(); });
    hand.append(analysis); container.append(hand);
  }
  function resetAnalysis() { analysisController?.abort(); analysisController = null; analysisPanel = null; analysisOpen = false; }
  function renderControls(s) {
    const bar = el('div', 'pt-controls'), life = el('div', 'pt-life'); life.append(el('span', 'pt-stat-label', '生命'), el('strong', '', s.life));
    for (const delta of [-5, -1, 1, 5]) { const b = button(delta > 0 ? `+${delta}` : `${delta}`, () => act({ type: 'life', delta }), 'pt-step'); b.setAttribute('aria-label', `生命${delta > 0 ? '增加' : '减少'}${Math.abs(delta)}`); life.append(b); }
    const turn = el('div', 'pt-turn'), actions = el('div', 'pt-turn-actions');
    const next = button('下一回合', () => act({ type: 'nextTurn' }), 'button button-primary pt-turn-button');
    const draw = button('抓牌', () => act({ type: 'draw', count: 1 }), 'button button-primary pt-turn-button');
    actions.append(next, draw); turn.append(el('strong', '', `第 ${s.turn} 回合`), actions);
    for (const tool of tableTools(s)) {
      const control = button(tool.label, tool.run, 'button button-quiet pt-overflow-tool');
      control.setAttribute('data-pt-tool', tool.key); actions.append(control);
    }
    actions.append(button('更多 ⋯', () => openLayer({ kind: 'tools' }), 'button button-quiet pt-more'));
    bar.append(life, turn); return bar;
  }
  function renderBattlefield(s) {
    const battlefield = el('section', 'pt-battlefield'); battlefield.setAttribute('data-drop-zone', 'battlefield'); battlefield.setAttribute('aria-label', '战场');
    battlefield.append(zoneHeading(s, 'battlefield'));
    const canvas = el('div', 'pt-battlefield-canvas');
    canvas.setAttribute('data-drop-zone', 'battlefield-free');
    for (const id of s.zones.battlefield) {
      const position = s.battlefieldPositions[id], holder = el('div', 'pt-free-card pt-board-slot');
      holder.setAttribute('data-row', position.row); holder.setAttribute('data-slot', position.slot);
      holder.setAttribute('data-board-id', id); holder.setAttribute('data-drop-zone', 'battlefield-free');
      holder.style.zIndex = String(boardOrder.get(id) || 1);
      holder.append(tile(s.pieces[id], s, 'battlefield')); canvas.append(holder);
    }
    battlefield.append(canvas);
    return battlefield;
  }
  function zoneHeading(s, zone) {
    const heading = el('div', 'pt-zone-heading');
    const title = el('h2', 'pt-zone-title');
    const menu = button(`${ZONES[zone]} · ${s.zones[zone].length} ▾`, () => openLayer({ kind: 'zone', zone }), 'pt-zone-menu-button');
    menu.setAttribute('aria-label', `${ZONES[zone]}操作`); menu.setAttribute('aria-haspopup', 'dialog');
    title.append(menu); heading.append(title); return heading;
  }
  function libraryPile(s) {
    const pile = el('section', 'pt-zone-pile pt-library-pile');
    pile.setAttribute('aria-label', '牌库'); pile.setAttribute('data-drop-zone', 'library-top');
    const title = button(`牌库 ${s.zones.library.length} ▾`, () => openLayer({ kind: 'library', mode: 'menu' }), 'pt-pile-label');
    title.setAttribute('data-library-title', ''); title.setAttribute('aria-haspopup', 'dialog');
    const topId = s.zones.library[0], piece = s.showLibraryTop ? s.pieces[topId] : null;
    const back = button('', () => {
      if (back.isConnected) act({ type: 'draw', count: 1 });
    }, `pt-library-back${piece ? ' is-revealed' : ''}`);
    back.setAttribute('aria-label', piece ? `抓一张牌：${nameOf(piece)}` : '抓一张牌'); back.disabled = !topId;
    if (topId) {
      back.setAttribute('data-piece-id', topId);
      gestures.push(attachCardGestures(back, { id: topId, zone: 'library-top', onDrop: moveCard }));
    }
    const front = el('span', 'pt-library-back-face');
    if (piece) front.append(cardFace(piece));
    else { const image = el('img', 'pt-standard-back'); image.src = './assets/mtg-card-back.png'; image.alt = '万智牌卡背'; image.draggable = false; front.append(image); }
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
    const lower = el('div', 'pt-lower-table'), hand = el('section', 'pt-hand'); hand.setAttribute('data-drop-zone', 'hand'); hand.setAttribute('aria-label', '手牌'); hand.append(zoneHeading(s, 'hand'), strip(s, 'hand'));
    const piles = el('div', 'pt-zone-piles'); piles.append(libraryPile(s));
    for (const zone of ['graveyard', 'exile', 'command']) {
      const pile = el('section', 'pt-zone-pile'); pile.setAttribute('data-drop-zone', zone); pile.setAttribute('aria-label', ZONES[zone]);
      const open = button(`${ZONES[zone]} ${s.zones[zone].length} ▾`, () => openLayer({ kind: 'zone', zone }), 'pt-pile-label'); open.setAttribute('aria-haspopup', 'dialog'); pile.append(open);
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
      if (ruleText) section.append(appendManaText(el('p', 'pt-preview-text rule-text'), ruleText));
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
    renderZoneActions(s, parent, zone);
    if (zone === 'hand' || zone === 'battlefield') return;
    const list = el('div', 'pt-zone-list'); list.setAttribute('data-hand-scroll', ''); list.setAttribute('data-scroll-key', `overlay-${zone}`);
    for (const id of s.zones[zone]) list.append(tile(s.pieces[id], s, zone, { cleanupList: dialogGestures, horizontal: true }));
    if (!s.zones[zone].length) list.append(el('p', 'pt-empty', '0 张'));
    parent.append(list);
  }
  function renderZoneActions(s, parent, zone) {
    const shortcuts = el('div', 'pt-menu-actions');
    if (zone === 'battlefield') shortcuts.append(button('全部重置', () => act({ type: 'untapAll' }, { dismiss: true })));
    if (zone === 'hand') {
      const random = el('form', 'pt-random-form'), count = number(1, 1, Math.max(1, s.zones.hand.length), '随机弃牌张数');
      const discard = button('随机弃牌', () => {}); discard.type = 'submit'; discard.disabled = !s.zones.hand.length;
      random.append(count, discard); random.addEventListener('submit', event => { event.preventDefault(); act({ type: 'randomDiscard', count: Number(count.value) }, { dismiss: true }); });
      const shuffle = button('全部洗回牌库', () => act({ type: 'batchMove', from: 'hand', ids: s.zones.hand, to: 'library', position: 'shuffle' }, { dismiss: true })); shuffle.disabled = !s.zones.hand.length;
      shortcuts.append(shuffle); parent.append(random);
    }
    if (shortcuts.children.length) parent.append(shortcuts);
    const details = el('details', 'pt-batch-panel'); details.append(el('summary', '', '批量移动…'));
    const form = el('form', 'pt-batch-form'), filter = el('select', 'pt-input'), destination = el('select', 'pt-input'), position = el('select', 'pt-input');
    filter.setAttribute('aria-label', '批量移动类别'); destination.setAttribute('aria-label', '批量移动目标'); position.setAttribute('aria-label', '放入牌库位置');
    const choices = [['all', '所有牌'], ['Land', '所有地'], ['nonland', '所有非地牌'], ['Creature', '所有生物'], ['Artifact', '所有神器'], ['Enchantment', '所有结界'], ['Planeswalker', '所有鹏洛客'], ['other', '其他类别…']];
    for (const [value, label] of choices) { const option = el('option', '', label); option.value = value; filter.append(option); }
    for (const [value, label] of Object.entries(ZONES)) {
      if (value === zone || value === 'stack' && !s.zones.stack.length) continue;
      const option = el('option', '', label); option.value = value; destination.append(option);
    }
    destination.value = zone === 'graveyard' ? 'hand' : 'graveyard';
    for (const [value, label] of [['top', '牌库顶'], ['bottom', '牌库底'], ['shuffle', '洗入牌库']]) { const option = el('option', '', label); option.value = value; position.append(option); }
    const other = input(); other.placeholder = '类别、超类别或副类别'; other.setAttribute('aria-label', '批量移动其他类别'); other.setAttribute('list', 'pt-batch-types');
    const vocabulary = el('datalist'); vocabulary.id = 'pt-batch-types';
    for (const type of typeOptions) { const option = el('option', '', `${type.value} · ${type.detail}`); option.value = type.label; vocabulary.append(option); }
    const submit = button('', () => {}, 'button button-primary'); submit.type = 'submit';
    const count = el('p', 'pt-batch-count'); count.setAttribute('aria-live', 'polite');
    const ids = () => s.zones[zone].filter(id => matchesPlaytestType(s.pieces[id], cardOf(s.pieces[id]), filter.value === 'other' ? other.value || '__empty__' : filter.value, typeOptions));
    function refresh() {
      other.hidden = filter.value !== 'other'; position.hidden = destination.value !== 'library';
      const matching = ids(); submit.textContent = `移动 ${matching.length} 张`; submit.disabled = !matching.length;
      count.textContent = `${ZONES[zone]} → ${ZONES[destination.value]} · ${matching.length} 张`;
    }
    for (const control of [filter, destination, other, position]) control.addEventListener('input', refresh);
    form.append(filter, el('span', 'pt-batch-to', '移至'), destination, other, vocabulary, position, count, submit);
    form.addEventListener('submit', event => { event.preventDefault(); act({ type: 'batchMove', from: zone, ids: ids(), to: destination.value, position: destination.value === 'library' ? position.value : 'bottom' }, { dismiss: true }); });
    details.append(form); parent.append(details); refresh();
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
    if (mode === 'menu') renderZoneActions(s, parent, 'library');
  }
  function tableTools(s) {
    if (s.phase !== 'playing') return [];
    return [
      { key: 'search', label: '搜寻', run: () => openLayer({ kind: 'library', mode: 'search' }) },
      { key: 'shuffle', label: '洗牌', run: () => act({ type: 'shuffle' }, { dismiss: true }) },
      { key: 'dice', label: '掷骰', run: () => openLayer({ kind: 'dice' }) },
      { key: 'tokens', label: '衍生物', run: () => openLayer({ kind: 'tokens' }) },
      { key: 'drawMany', label: '抓多张牌', run: () => openLayer({ kind: 'draw' }) },
      ...(s.zones.stack.length ? [{ key: 'stack', label: `堆叠 ${s.zones.stack.length}`, run: () => openLayer({ kind: 'zone', zone: 'stack' }) }] : []),
    ];
  }
  function renderTools(s, parent) {
    const actions = el('div', 'pt-menu-actions');
    for (const tool of tableTools(s).filter(tool => overflowTools.includes(tool.key))) actions.append(button(tool.label, tool.run));
    actions.append(button('重开测试', () => { closeOverlays(); savedSession = session; screen = 'setup'; render(); }));
    parent.append(actions);
  }
  function renderDraw(parent) {
    const draw = el('form', 'pt-random-form'), count = number(1, 1, 1000, '抓牌张数'), submit = button('抓牌', () => {}); submit.type = 'submit'; draw.append(count, submit);
    draw.addEventListener('submit', event => { event.preventDefault(); act({ type: 'draw', count: Number(count.value) }, { dismiss: true }); });
    parent.append(draw);
  }
  function renderDice(s, parent) {
    const form = el('form', 'pt-dice-form'), sides = number(s.lastRoll?.sides || 6, 2, 1000, '骰子面数'), count = number(1, 1, 20, '骰子个数');
    const choices = el('div', 'pt-menu-actions');
    for (const value of [6, 20, 2]) choices.append(button(`D${value}`, () => { sides.value = value; }));
    const roll = button('掷骰', () => {}, 'button button-primary'); roll.type = 'submit';
    form.append(choices, field('面数', sides), field('个数', count), roll);
    form.addEventListener('submit', event => { event.preventDefault(); act({ type: 'roll', sides: Number(sides.value), count: Number(count.value) }); });
    parent.append(form);
    if (s.lastRoll) { const result = el('output', 'pt-dice-result', s.lastRoll.values.join(' · ')); result.setAttribute('aria-live', 'polite'); parent.append(result); }
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
    const title = kind === 'card' ? nameOf(s.pieces[layer.id]) : tray ? `${ZONES[layer.zone || 'library']} · ${s.zones[layer.zone || 'library'].length}` : kind === 'tools' ? '更多操作' : kind === 'dice' ? '掷骰' : kind === 'draw' ? '抓多张牌' : '创建衍生物';
    const heading = el('header', 'pt-dialog-heading'), h = el('h2', '', title); h.id = 'pt-dialog-title'; n.setAttribute('aria-labelledby', h.id);
    if (kind === 'library' && layer.mode !== 'menu') heading.append(button('← 牌库操作', () => { layer = { kind: 'library', mode: 'menu' }; renderDialog(); }));
    heading.append(h, button('关闭', () => closeDialog())); n.append(heading);
    if (kind === 'card') renderCardMenu(s, n, layer.id);
    else if (kind === 'zone') renderZoneMenu(s, n, layer.zone);
    else if (kind === 'library') renderLibraryMenu(s, n, layer.mode);
    else if (kind === 'tools') renderTools(s, n);
    else if (kind === 'dice') renderDice(s, n);
    else if (kind === 'draw') renderDraw(n);
    else renderTokenForm(n);
    n.addEventListener('cancel', e => { e.preventDefault(); closeDialog(); }); n.addEventListener('close', () => { if (dialog === n) closeDialog(); });
    n.addEventListener('click', e => { if (e.target !== n || tray) return; const r = n.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(); });
    container.append(n);
    // Zone trays stay non-modal so cards can be dragged back onto the table.
    if (tray) n.show?.(); else n.showModal?.();
    layoutTable();
  }
  function render() {
    const active = document.activeElement;
    const focusKey = dialog?.contains?.(active) ? active.getAttribute('aria-label') || active.textContent : null;
    const scrolls = new Map(Array.from(container.querySelectorAll?.('[data-scroll-key]') || [], n => [n.getAttribute('data-scroll-key'), [n.scrollLeft, n.scrollTop]]));
    disposeDialog(); clean(gestures); container.replaceChildren(); header();
    container.classList.toggle('pt-is-opening', screen !== 'setup' && state().phase === 'opening');
    container.classList.toggle('pt-is-setup', screen === 'setup');
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
    layoutTable();
    tableObserver?.disconnect(); tableObserver?.observe(container);
    const canvas = container.querySelector('.pt-battlefield-canvas'); if (canvas) tableObserver?.observe(canvas);
  }
  function layoutTable() {
    const view = container.ownerDocument?.defaultView;
    if (!view?.getComputedStyle) return;
    layoutActions(view);
    const canvas = container.querySelector('.pt-battlefield-canvas');
    if (canvas && session) {
      const s = state(), sample = canvas.querySelector('.pt-free-card');
      const caption = sample ? parseFloat(view.getComputedStyle(sample).getPropertyValue('--pt-board-caption')) || 0 : 0;
      const defaults = s.zones.battlefield.filter(id => s.battlefieldPositions[id].x === undefined);
      const cramped = canvas.clientHeight < 230, count = Math.max(1, Math.min(4, defaults.length));
      const rowFit = cramped ? (canvas.clientWidth - 40 - (count - 1) * 6) / count : Infinity;
      container.style.setProperty('--pt-board-fit', `${Math.max(28, Math.floor(Math.min(rowFit, (canvas.clientHeight - 16 - caption) * 488 / 680)))}px`);
      const upperCount = defaults.filter(id => s.battlefieldPositions[id].row === 'upper').length;
      for (const holder of canvas.querySelectorAll('.pt-free-card')) {
        const position = s.battlefieldPositions[holder.getAttribute('data-board-id')];
        if (!position) continue;
        const initial = cramped && position.x === undefined ? { ...position, slot: position.slot + (position.row === 'lower' ? upperCount : 0) } : position;
        const point = battlefieldPoint(initial, canvas.clientWidth, canvas.clientHeight, holder.offsetWidth, holder.offsetHeight);
        holder.style.left = `${point.x}px`; holder.style.top = `${point.y}px`;
      }
    }
    const hand = container.querySelector('.pt-hand .pt-hand-row');
    if (hand?.firstElementChild) {
      const style = view.getComputedStyle(hand), width = hand.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      hand.style.setProperty('--pt-hand-gap', `${handCardGap(width, hand.firstElementChild.offsetWidth, hand.children.length)}px`);
    }
    const shelf = container.querySelector('.pt-library-peek');
    if (shelf && hand) {
      shelf.style.top = view.innerWidth <= 700 && view.innerHeight > view.innerWidth
        ? `${Math.max(52, hand.getBoundingClientRect().top - shelf.offsetHeight * .65)}px` : '';
    }
    for (const card of container.querySelectorAll('.pt-card')) {
      const image = card.querySelector('.pt-card-visual'), menu = card.querySelector('.pt-card-menu');
      if (!image || !menu || !card.offsetWidth) continue;
      const art = image.getBoundingClientRect(), bounds = card.getBoundingClientRect();
      menu.style.left = `${art.left - bounds.left + 2}px`;
      menu.style.top = `${art.bottom - bounds.top - menu.offsetHeight - 2}px`;
    }
  }
  function layoutActions(view) {
    const actions = container.querySelector('.pt-turn-actions');
    if (!actions?.clientWidth) return;
    const tools = Array.from(actions.querySelectorAll('[data-pt-tool]'));
    for (const control of tools) control.hidden = false;
    const buttons = Array.from(actions.children), style = view.getComputedStyle(actions), gap = parseFloat(style.columnGap) || 0;
    const width = control => control.classList.contains('pt-turn-button') ? parseFloat(view.getComputedStyle(control).minWidth) || 80 : control.getBoundingClientRect().width;
    let total = buttons.reduce((sum, control) => sum + width(control), 0) + (buttons.length - 1) * gap;
    for (let i = tools.length - 1; i >= 0 && total > actions.clientWidth; i--) { total -= width(tools[i]) + gap; tools[i].hidden = true; }
    const hidden = tools.filter(control => control.hidden).map(control => control.getAttribute('data-pt-tool'));
    const changed = hidden.join() !== overflowTools.join(); overflowTools = hidden;
    if (changed && layer?.kind === 'tools') queueMicrotask(() => { if (layer?.kind === 'tools') renderDialog(); });
  }
  function open(nextDeck) {
    resetAnalysis();
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
  if (typeof ResizeObserver === 'function') tableObserver = new ResizeObserver(layoutTable);
  return { open, closeOverlays, destroy() { tableObserver?.disconnect(); resetAnalysis(); closeOverlays({ restoreFocus: false }); clean(gestures); document.removeEventListener?.('keydown', onKeyDown); container.replaceChildren(); session = null; } };
}
