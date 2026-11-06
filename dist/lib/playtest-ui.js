import { PlaytestSession, PLAYTEST_DEFAULTS, PLAYTEST_ZONES } from './playtest.js';
import { PlaytestStorage } from './playtest-storage.js';
import { getVersion } from './decks.js';

const ZONES = { hand: '手牌', battlefield: '战场', graveyard: '坟场', exile: '放逐区', command: '统帅区', stack: '堆叠', library: '牌库' };
function el(tag, cls = '', text) { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function button(text, fn, cls = 'button button-quiet') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', fn); return node; }
function field(label, input) { const node = el('label', 'pt-field'); node.append(el('span', '', label), input); return node; }
function input(value = '', type = 'text') { const node = el('input', 'pt-input'); node.type = type; node.value = value; return node; }
function number(value, min, max, label) { const node = input(value, 'number'); node.min = min; node.max = max; node.step = '1'; if (label) node.setAttribute('aria-label', label); return node; }
function check(text, checked) { const control = input('', 'checkbox'); control.checked = checked; const label = el('label', 'pt-check'); label.append(control, el('span', '', text)); return { control, label }; }
function download(raw, name) { const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' })); const link = el('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

export function initPlaytestUI({ container, cards, onInspect = () => {}, onExit = () => {}, onNotify = () => {} }) {
  const index = new Map(cards.map(card => [card.id, card]));
  const storage = new PlaytestStorage();
  let deck = null, session = null, screen = 'setup', zone = 'hand', selectedId = null, bottomIds = [], libraryOpen = false, libraryQuery = '', saveError = '', savedAt = '', recoveryError = '', recoveryRaw = null, savedSession = null;
  function state() { return session.state; }
  function displayName(piece) { const card = index.get(piece.cardId), face = card?.faces?.[piece.face]; return face?.zhName || face?.name || piece.name; }
  function cardFace(piece) { const card = index.get(piece.cardId); return card?.faces?.[piece.face] || card || piece; }
  function imageURL(piece) { const card = index.get(piece.cardId), version = getVersion(card, piece.versionId); return version?.faceImages?.[piece.face] || (piece.face ? card?.faces?.[piece.face]?.image : version?.image) || card?.faces?.[piece.face]?.image || card?.image; }
  function save() { try { storage.save(deck.id, session.export()); savedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); saveError = ''; } catch (error) { saveError = error.message; onNotify(error.message, 'error'); } }
  function act(action) {
    try { if (action === 'undo') session.undo(); else if (action === 'redo') session.redo(); else session.dispatch(action); bottomIds = bottomIds.filter(id => state().zones.hand.includes(id)); save(); render(); return true; }
    catch (error) { onNotify(error.message, 'error'); return false; }
  }
  function header() {
    const header = el('header', 'pt-heading');
    const title = el('div'); title.append(button('← 返回卡组编辑', onExit, 'pt-back'), el('p', 'pt-eyebrow', 'PLAYTEST TABLE'), el('h1', '', '手动测试'), el('p', 'pt-deck-name', deck.name));
    const actions = el('div', 'pt-actions');
    if (session && screen === 'table') actions.append(button('重开 / 设置', () => { screen = 'setup'; savedSession = session; render(); }));
    header.append(title, actions); container.append(header);
  }
  function renderSetup() {
    const layout = el('div', 'pt-setup-layout'), form = el('form', 'pt-setup');
    form.append(el('h2', '', '准备一场测试'), el('p', 'pt-muted', '使用当前牌表的独立快照。统帅留在统帅区，候选牌不加入牌库。'));
    const count = deck.entries.filter(e => e.zone === 'main').reduce((sum, e) => sum + e.quantity, 0), commanders = deck.entries.filter(e => e.zone === 'commander').reduce((sum, e) => sum + e.quantity, 0);
    form.append(el('div', 'pt-snapshot-summary', `${count} 张主牌 · ${commanders} 张统帅 · 支持未完成的草稿`));
    const defaults = session?.state.settings || PLAYTEST_DEFAULTS;
    const opening = number(defaults.openingHandSize, 1, 20), life = number(defaults.startingLife, 1, 9999), free = number(defaults.freeMulligans, 0, 10);
    const fields = el('div', 'pt-setup-fields'); fields.append(field('起手张数', opening), field('起始生命', life), field('免费调度次数', free)); form.append(fields);
    const first = check('第 1 回合开始时抓一张牌', defaults.drawFirstTurn), each = check('后续回合开始时抓一张牌', defaults.drawEachTurn), untap = check('后续回合开始时重置战场上的牌', defaults.untapEachTurn);
    form.append(first.label, each.label, untap.label, el('p', 'pt-muted', '保留起手后进入第 1 回合。每次调度重抓起手，保留时按付费调度次数选择沉底牌。'));
    if (savedSession) {
      const old = savedSession.state, resume = el('section', 'pt-resume');
      resume.append(el('strong', '', '有一场未结束的测试'), el('p', 'pt-muted', `${old.deck.name} · ${old.phase === 'opening' ? '正在选择起手' : `第 ${old.turn} 回合 · ${old.life} 点生命`} · ${old.zones.hand.length} 张手牌`), el('p', 'pt-muted', '继续使用当时的牌表快照。新建测试会替换这套卡组的旧测试进度。'), button('继续上次测试', () => { session = savedSession; screen = 'table'; zone = 'hand'; selectedId = null; bottomIds = []; save(); render(); }, 'button button-primary'));
      form.append(resume);
    }
    let overwrite = null;
    if (recoveryError) {
      const error = el('section', 'pt-recovery'); error.setAttribute('role', 'alert'); error.append(el('strong', '', '旧测试进度暂时无法恢复'), el('p', '', recoveryError));
      if (recoveryRaw !== null) error.append(button('下载原始测试进度', () => download(recoveryRaw, 'edh-playtest-recovery.json')));
      overwrite = check('允许新建测试覆盖这套卡组的旧测试进度', false); error.append(overwrite.label); form.append(error);
    }
    const error = el('p', 'pt-error'); error.setAttribute('role', 'alert'); error.hidden = true;
    const start = button(savedSession || recoveryError ? '按当前牌表新建测试' : '洗牌并查看起手', () => {}, 'button button-primary pt-start'); start.type = 'submit';
    if (overwrite) { start.disabled = true; overwrite.control.addEventListener('change', () => { start.disabled = !overwrite.control.checked; }); }
    form.append(error, start);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (overwrite && !overwrite.control.checked) return;
      try { session = new PlaytestSession(deck, cards, { openingHandSize: Number(opening.value), startingLife: Number(life.value), freeMulligans: Number(free.value), drawFirstTurn: first.control.checked, drawEachTurn: each.control.checked, untapEachTurn: untap.control.checked }); screen = 'table'; zone = 'hand'; selectedId = null; bottomIds = []; libraryOpen = false; libraryQuery = ''; savedSession = null; recoveryError = ''; save(); render(); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
    });
    const aside = el('aside', 'pt-setup-note'); aside.append(el('span', 'pt-note-mark', '↷'), el('h2', '', '按自己的节奏试牌'), el('p', '', '抓牌、下地、施放和移动卡牌，看看这套构筑如何展开。常见操作支持撤销与重做。'), el('p', '', '费用、牌张效果、战斗、统帅税与替代性效应由你手动处理。堆叠作为暂存区域，结算时将牌移到对应区域。'), el('p', 'pt-muted', '测试进度保存在当前浏览器。重开、调度、创建衍生物等操作只影响本次测试。'));
    layout.append(form, aside); container.append(layout);
  }
  function renderStatus(s) {
    const bar = el('div', 'pt-status-bar');
    const life = el('div', 'pt-life'); life.append(el('span', 'pt-stat-label', '生命'), el('strong', '', s.life));
    for (const delta of [-5, -1, 1, 5]) { const b = button(delta > 0 ? `+${delta}` : `${delta}`, () => act({ type: 'life', delta }), 'pt-step'); b.disabled = s.phase === 'opening'; b.setAttribute('aria-label', `生命${delta > 0 ? '增加' : '减少'}${Math.abs(delta)}`); life.append(b); }
    const turn = el('div', 'pt-turn'); turn.append(el('span', 'pt-stat-label', s.phase === 'opening' ? '起手阶段' : '当前回合'), el('strong', '', s.phase === 'opening' ? '准备中' : `第 ${s.turn} 回合`));
    if (s.phase === 'playing') turn.append(button('下一回合 →', () => act({ type: 'nextTurn' }), 'button button-primary'), el('small', 'pt-muted', [s.settings.untapEachTurn ? '自动重置' : '手动重置', s.settings.drawEachTurn ? '抓一张牌' : '手动抓牌'].join(' · ')));
    const history = el('div', 'pt-history'); const undo = button('↶ 撤销', () => act('undo')), redo = button('↷ 重做', () => act('redo')); undo.disabled = !session.canUndo; redo.disabled = !session.canRedo; history.append(undo, redo);
    bar.append(life, turn, history); container.append(bar);
    const status = el('div', `pt-save-status${saveError ? ' has-error' : ''}`); status.setAttribute('role', 'status'); status.append(el('span', '', saveError || `测试进度已保存在此浏览器${savedAt ? ` · ${savedAt}` : ''}`)); if (saveError) status.append(button('重试保存', () => { save(); render(); })); container.append(status);
  }
  function renderOpening(s) {
    const panel = el('section', 'pt-opening');
    panel.append(el('div', '', ''), el('h2', '', '这手牌，值得保留吗？'), el('p', 'pt-muted', `已调度 ${s.mulligans} 次 · 前 ${s.settings.freeMulligans} 次免费 · 当前 ${s.zones.hand.length} 张手牌`));
    const required = s.bottomRequired;
    panel.append(el('p', 'pt-bottom-hint', required ? `点击选择 ${required} 张牌沉底（已选 ${bottomIds.length}/${required}）。选择顺序从靠近牌库顶到最底。` : '当前无需沉底。你可以保留，或重新洗牌调度。'));
    const actions = el('div', 'pt-actions');
    const paid = Math.max(0, s.mulligans + 1 - s.settings.freeMulligans), possible = Math.min(s.settings.openingHandSize, s.zones.hand.length + s.zones.library.length);
    const mulligan = button(`重新调度${paid ? `（需沉底 ${paid} 张）` : '（免费）'}`, () => { bottomIds = []; act({ type: 'mulligan' }); }); mulligan.disabled = paid > possible;
    const keep = button('保留并开始', () => act({ type: 'keep', bottomIds }), 'button button-primary'); keep.disabled = bottomIds.length !== required;
    actions.append(mulligan, keep); panel.append(actions, el('p', 'pt-muted', s.settings.drawFirstTurn ? '开始第 1 回合时会自动再抓一张牌。' : '开始第 1 回合时不自动抓牌。')); container.append(panel);
  }
  function tile(piece, s, { library = false } = {}) {
    const opening = s.phase === 'opening', selectedBottom = bottomIds.indexOf(piece.id);
    const tile = button('', () => {
      if (opening) {
        if (!s.bottomRequired) { selectedId = selectedId === piece.id ? null : piece.id; }
        else if (selectedBottom >= 0) bottomIds.splice(selectedBottom, 1);
        else if (bottomIds.length < s.bottomRequired) bottomIds.push(piece.id);
        else { onNotify(`最多选择 ${s.bottomRequired} 张沉底牌`, 'info'); return; }
      } else selectedId = piece.id;
      render();
      if (!opening && window.matchMedia('(max-width: 700px)').matches) container.querySelector('.pt-selection')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, `pt-card${piece.tapped ? ' is-tapped' : ''}${selectedId === piece.id ? ' is-selected' : ''}${selectedBottom >= 0 ? ' is-bottom' : ''}${library ? ' pt-library-card' : ''}`);
    tile.setAttribute('aria-label', `${displayName(piece)}${piece.tapped ? '，已横置' : ''}${selectedBottom >= 0 ? `，沉底顺序${selectedBottom + 1}` : ''}`); tile.setAttribute('aria-pressed', String(opening && s.bottomRequired ? selectedBottom >= 0 : selectedId === piece.id));
    if (!library) {
      const visual = el('span', 'pt-card-visual'), url = imageURL(piece);
      const fallback = el('span', 'pt-card-fallback', piece.token ? '✦' : '♧'); visual.append(fallback);
      if (url && /^https?:\/\//i.test(url)) { const image = el('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; image.addEventListener('error', () => image.remove(), { once: true }); visual.append(image); }
      if (piece.tapped) visual.append(el('span', 'pt-card-badge', '↷ 已横置'));
      if (selectedBottom >= 0) visual.append(el('span', 'pt-bottom-badge', `沉底 ${selectedBottom + 1}`));
      if (piece.token) visual.append(el('span', 'pt-token-badge', '衍生物'));
      tile.append(visual);
    }
    const info = el('span', 'pt-card-info'); info.append(el('strong', '', displayName(piece)), el('small', '', cardFace(piece).zhTypeLine || cardFace(piece).typeLine || ''));
    const badges = el('span', 'pt-card-counters'); for (const [name, value] of Object.entries(piece.counters)) badges.append(el('span', '', `${name} ×${value}`));
    if (piece.token && (piece.power || piece.toughness)) badges.append(el('span', '', `${piece.power || '?'}/${piece.toughness || '?'}`));
    if (piece.face) badges.append(el('span', '', `牌面 ${piece.face + 1}`));
    info.append(badges); tile.append(info); return tile;
  }
  function renderBoard(s) {
    const table = el('div', 'pt-table'), board = el('section', 'pt-board');
    const tabs = el('div', 'pt-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', '测试牌张区域');
    for (const key of ['hand', 'battlefield', 'graveyard', 'exile', 'command', 'stack']) {
      const b = button(`${ZONES[key]} ${s.zones[key].length}`, () => { zone = key; selectedId = null; render(); }, `pt-tab${zone === key ? ' active' : ''}`); b.setAttribute('aria-pressed', String(zone === key)); b.disabled = s.phase === 'opening' && key !== 'hand'; tabs.append(b);
    }
    board.append(tabs);
    const zoneHeading = el('div', 'pt-zone-heading'); zoneHeading.append(el('h2', '', `${ZONES[zone]} · ${s.zones[zone].length}`));
    if (zone === 'battlefield') zoneHeading.append(el('span', 'pt-muted', `本回合下地 ${s.landsPlayed}/${s.landLimit}`));
    if (zone === 'stack') zoneHeading.append(el('span', 'pt-muted', '末尾为堆叠顶；选择牌张后手动移动以结算'));
    board.append(zoneHeading);
    const grid = el('div', 'pt-card-grid');
    for (const id of s.zones[zone]) grid.append(tile(s.pieces[id], s));
    if (!s.zones[zone].length) grid.append(el('p', 'pt-empty', `这里还没有牌。${zone === 'battlefield' ? '从手牌下地，或将结算后的永久物移入战场。' : ''}`)); board.append(grid);
    const side = el('aside', 'pt-side'); renderLibrary(s, side); renderSelection(s, side); table.append(board, side); container.append(table);
  }
  function renderLibrary(s, parent) {
    const panel = el('section', 'pt-panel'); panel.append(el('div', 'pt-library-heading', ''), el('h2', '', '牌库'), el('strong', 'pt-library-count', `${s.zones.library.length} 张`));
    if (s.phase === 'playing') {
      const drawForm = el('form', 'pt-draw-form'), count = number(1, 1, 1000, '抓牌张数'), draw = button('抓牌', () => {}, 'button button-primary'); draw.type = 'submit'; drawForm.append(count, draw); drawForm.addEventListener('submit', e => { e.preventDefault(); act({ type: 'draw', count: Number(count.value) }); });
      const controls = el('div', 'pt-actions'); controls.append(button('洗牌', () => act({ type: 'shuffle' })), button(libraryOpen ? '收起牌库' : '查看 / 搜索牌库', () => { libraryOpen = !libraryOpen; render(); })); panel.append(drawForm, controls);
      if (libraryOpen) {
        const search = input(libraryQuery, 'search'); search.placeholder = '搜索中文 / 英文牌名'; search.setAttribute('aria-label', '搜索测试牌库'); panel.append(search);
        const list = el('div', 'pt-library-list');
        const update = () => { libraryQuery = search.value; const text = libraryQuery.normalize('NFKC').toLocaleLowerCase(); const ids = s.zones.library.filter(id => { const p = s.pieces[id], c = index.get(p.cardId); return `${p.name} ${c?.name || ''}`.normalize('NFKC').toLocaleLowerCase().includes(text); }); list.replaceChildren(el('p', 'pt-muted', `${ids.length} 张匹配 · 按牌顶至牌底排序${ids.length > 50 ? ' · 显示前 50 张' : ''}`)); for (const id of ids.slice(0, 50)) list.append(tile(s.pieces[id], s, { library: true })); };
        search.addEventListener('input', update); update(); panel.append(el('p', 'pt-muted', '展开会看到牌库顺序。选中后可找入手牌、移至牌顶或牌底。'), list);
      }
    } else panel.append(el('p', 'pt-muted', '保留起手后，可以抓牌、找牌和洗牌。'));
    parent.append(panel);
  }
  function renderSelection(s, parent) {
    const panel = el('section', 'pt-panel pt-selection'); panel.append(el('h2', '', '选中卡牌'));
    const piece = s.pieces[selectedId]; if (!piece) { panel.append(el('p', 'pt-muted', s.phase === 'opening' && s.bottomRequired ? '点击起手牌选择沉底顺序。' : '点击一张牌，查看详情或执行操作。')); parent.append(panel); return; }
    const card = index.get(piece.cardId), from = PLAYTEST_ZONES.find(key => s.zones[key].includes(piece.id));
    panel.append(el('h3', '', displayName(piece)), el('p', 'pt-muted', `${ZONES[from]}${piece.tapped ? ' · 已横置' : ''}`));
    if (card) panel.append(button('查看中文规则 ↗', () => onInspect(card, getVersion(card, piece.versionId))));
    if (s.phase === 'playing') {
      const actions = el('div', 'pt-actions');
      if (from === 'hand' && /\bLand\b/.test(cardFace(piece).typeLine || '')) actions.append(button('下地', () => { if (act({ type: 'playLand', id: piece.id })) { zone = 'battlefield'; render(); } }, 'button button-primary'));
      if (!piece.token && ['hand', 'command'].includes(from) && !/\bLand\b/.test(cardFace(piece).typeLine || '')) actions.append(button('施放 → 堆叠', () => { if (act({ type: 'cast', id: piece.id })) { zone = 'stack'; render(); } }, 'button button-primary'));
      if (from === 'battlefield') actions.append(button(piece.tapped ? '重置' : '横置', () => act({ type: 'tap', id: piece.id })));
      if ((card?.faces?.length || 0) > 1) actions.append(button('切换牌面', () => act({ type: 'flip', id: piece.id })));
      panel.append(actions);
      const movement = el('form', 'pt-move-form'), destination = el('select', 'pt-input'); destination.setAttribute('aria-label', '移动卡牌到');
      for (const [key, label] of Object.entries(ZONES)) { if (key === 'library') continue; const option = el('option', '', label); option.value = key; destination.append(option); }
      for (const [value, label] of [['library-top', '牌库顶'], ['library-bottom', '牌库底']]) { const option = el('option', '', label); option.value = value; destination.append(option); }
      destination.value = from === 'stack' ? (/\b(Instant|Sorcery)\b/.test(cardFace(piece).typeLine || '') ? 'graveyard' : 'battlefield') : from === 'library' ? 'hand' : 'graveyard';
      const move = button('移动', () => {}, 'button button-quiet'); move.type = 'submit'; movement.append(field('手动移动到', destination), move); movement.addEventListener('submit', e => { e.preventDefault(); const to = destination.value.startsWith('library-') ? 'library' : destination.value; if (act({ type: 'move', id: piece.id, to, position: destination.value === 'library-top' ? 'top' : 'bottom' })) { if (to !== 'library') zone = to; render(); } }); panel.append(movement);
      if (from === 'battlefield') {
        const form = el('form', 'pt-counter-form'), name = input('+1/+1'), delta = number(1, -999, 999, '指示物变化'); name.maxLength = 50; name.setAttribute('aria-label', '指示物名称'); const add = button('应用指示物', () => {}); add.type = 'submit'; form.append(field('指示物名称', name), field('变化数量（可填负数）', delta), add); form.addEventListener('submit', e => { e.preventDefault(); act({ type: 'counter', id: piece.id, name: name.value, delta: Number(delta.value) }); }); panel.append(form);
      }
      if (piece.token) panel.append(button('移除衍生物', () => act({ type: 'removeToken', id: piece.id }), 'button pt-danger'));
      panel.append(el('p', 'pt-muted', '跨区域移动会清除横置与指示物；移回手牌、牌库等区域会恢复正面。下地以外的手动移动不计下地次数。'));
    }
    parent.append(panel);
  }
  function renderTools(s) {
    const layout = el('div', 'pt-tools');
    if (s.phase === 'playing') {
      const advanced = el('details', 'pt-panel'); advanced.append(el('summary', '', '额外操作 · 下地上限与衍生物'));
      const landForm = el('form', 'pt-inline-form'), limit = number(s.landLimit, 0, 99, '本回合下地上限'), apply = button('调整下地上限', () => {}); apply.type = 'submit'; landForm.append(field('本回合下地上限', limit), apply); landForm.addEventListener('submit', e => { e.preventDefault(); act({ type: 'setLandLimit', value: Number(limit.value) }); });
      advanced.append(landForm, el('p', 'pt-muted', '用于额外下地效果。下一回合恢复为 1 次。'));
      const form = el('form', 'pt-token-form'), name = input('衍生物'), type = input('生物 — 衍生物'), power = input('1'), toughness = input('1'), qty = number(1, 1, 50), create = button('创建衍生物', () => {}, 'button button-primary'); create.type = 'submit'; name.maxLength = 100; type.maxLength = 200; power.maxLength = toughness.maxLength = 20;
      form.append(field('衍生物名称', name), field('类别', type), field('力量', power), field('防御力', toughness), field('数量', qty), create); form.addEventListener('submit', e => { e.preventDefault(); act({ type: 'token', name: name.value, typeLine: type.value, power: power.value, toughness: toughness.value, quantity: Number(qty.value) }); zone = 'battlefield'; render(); }); advanced.append(form, el('p', 'pt-muted', '衍生物离开战场后可手动移除。统帅税、指挥官伤害与其他特殊计数请自行记录。')); layout.append(advanced);
    }
    const history = el('details', 'pt-panel pt-log'); history.append(el('summary', '', `操作记录 · 最近 ${s.log.length} 项`)); const list = el('ol'); for (const entry of s.log.slice().reverse()) list.append(el('li', '', `${entry.turn ? `回合 ${entry.turn}` : '起手'} · ${entry.text}`)); history.append(list); layout.append(history); container.append(layout);
    container.append(el('p', 'pt-footnote', `测试基于「${s.deck.name}」的独立牌表快照；所有测试操作均不修改原卡组。费用、规则效果、战斗与胜负请手动处理。`));
  }
  function render() { container.replaceChildren(); header(); if (screen === 'setup') { renderSetup(); return; } const s = state(); if (!s.pieces[selectedId]) selectedId = null; if (s.phase === 'opening') zone = 'hand'; renderStatus(s); if (s.phase === 'opening') renderOpening(s); renderBoard(s); renderTools(s); }
  function open(nextDeck) {
    const previous = session; deck = JSON.parse(JSON.stringify(nextDeck)); savedSession = previous?.state.deck.id === deck.id ? previous : null; session = savedSession; recoveryError = ''; recoveryRaw = null; saveError = ''; savedAt = ''; screen = 'setup'; selectedId = null; bottomIds = []; libraryOpen = false; libraryQuery = '';
    if (!savedSession) { try { const data = storage.load(deck.id); if (data) savedSession = PlaytestSession.restore(data, cards); } catch (error) { recoveryError = error.message; try { recoveryRaw = storage.raw(deck.id); } catch { /* The storage error is already shown. */ } } }
    render();
  }
  return { open, destroy() { container.replaceChildren(); session = null; } };
}
