import { SEATS, COMMANDER_QUERY, freshTable, startTable, finishTable, commanderRule, commanderEligible, commanderPairFits, commanderSnapshot } from './scoreboard-model.js';
import { createScoreboardStorage } from './scoreboard-storage.js';
import { winnerAward, lifeSymbol } from './scoreboard-art.js';

const el = (tag, cls = '', text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
const btn = (text, action, cls = 'button') => { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', action); return b; };
const label = player => player.commanders.map(c => c.zhName || c.name).join(' / ') || player.name;
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function createScoreboardUI({ container, catalog, onBack, onOpenTable = () => {}, notify = () => {} }) {
  let table, screen = 'table', ending = false, spinning = false, spinIndex = -1, timer, overlay, focusBefore, wakeLock;
  let endHint = '谁赢了？拖动圆钮到玩家面板', gesture, visible = false, operation = 0, historyManaged = false, menuOpen = false;
  const store = createScoreboardStorage({ onChange: () => { if (visible && screen === 'history' && !overlay) renderHistory(); } });
  const save = next => { try { store.saveTable(next); table = next; return true; } catch { notify('保存失败，请检查设备存储空间', 'error'); return false; } };
  function releaseScreen() {
    if (window.TieyouTable) window.TieyouTable.exit();
    else { screenOrientation()?.unlock?.(); if (document.fullscreenElement === container) void document.exitFullscreen().catch(() => {}); }
    if (wakeLock) { void wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  function screenOrientation() { return window.screen?.orientation; }
  async function fullscreen() {
    if (window.TieyouTable) window.TieyouTable.enter();
    else try { if (!document.fullscreenElement) await container.requestFullscreen(); await screenOrientation()?.lock?.('landscape'); } catch { /* Manual landscape remains available. */ }
    try { if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Power saving may deny it. */ }
  }
  function closeDialog() {
    if (!overlay) return false;
    overlay.cleanup?.(); overlay.remove(); overlay = null; focusBefore?.focus(); return true;
  }
  function dialog(title) {
    closeDialog(); focusBefore = document.activeElement;
    overlay = el('div', 'score-overlay');
    const panel = el('section', 'score-dialog'); panel.role = 'dialog'; panel.setAttribute('aria-modal', 'true');
    const heading = el('div', 'score-dialog-header'), h = el('h2', '', title); h.id = 'score-dialog-title'; panel.setAttribute('aria-labelledby', h.id);
    const close = btn('关闭', closeDialog); heading.append(h, close); panel.append(heading); overlay.append(panel); container.append(overlay);
    overlay.addEventListener('click', event => { if (event.target === overlay) closeDialog(); });
    queueMicrotask(() => { if (overlay && !panel.contains(document.activeElement)) close.focus(); }); return panel;
  }
  function writeEndHint() { container.querySelectorAll('.score-end-label').forEach(n => n.textContent = endHint); }
  function life(seat, delta) {
    if (ending || spinning || menuOpen || table.phase !== 'playing') return;
    const players = table.players.map((p, i) => i === seat ? { ...p, life: Math.max(-9999, Math.min(9999, p.life + delta)) } : p);
    if (save({ ...table, players })) {
      const number = container.querySelector(`[data-seat="${seat}"] .score-life`); number.textContent = players[seat].life; number.dataset.digits = String(players[seat].life).length;
      if (!matchMedia('(prefers-reduced-motion:reduce)').matches) number.animate([{ opacity: .5, transform: 'scale(.86)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 190, easing: 'ease-out' });
    }
  }
  function bindSeat(panel, seat) {
    let hold, start, held = false;
    const cancel = () => clearTimeout(hold);
    panel.addEventListener('contextmenu', e => e.preventDefault());
    panel.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || ending || spinning || menuOpen || e.button !== 0) return;
      held = false; start = { x: e.clientX, y: e.clientY };
      hold = setTimeout(() => { held = true; navigator.vibrate?.(25); editPlayer(seat); }, 600);
    });
    panel.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    panel.addEventListener('pointerup', cancel); panel.addEventListener('pointercancel', cancel); panel.addEventListener('pointerleave', cancel);
    panel.addEventListener('click', () => { if (ending && !held) { endHint = '拖动奖章，佩戴到赢家面板'; writeEndHint(); } });
    panel.addEventListener('dblclick', e => { e.preventDefault(); });
  }
  function renderTable() {
    closeDialog(); menuOpen = false; container.replaceChildren(); container.className = 'scoreboard' + (ending ? ' score-ending' : '') + (table.phase === 'ended' ? ' score-completed' : '');
    const completed = table.phase === 'ended' ? store.records.find(item => item.record.id === table.game?.id)?.record : null;
    const grid = el('div', 'score-grid');
    table.players.forEach((player, seat) => {
      const panel = el('section', 'score-seat'); panel.dataset.seat = seat; panel.setAttribute('aria-label', SEATS[seat]);
      panel.classList.toggle('is-lit', spinning && spinIndex === seat);
      panel.classList.toggle('is-first', !spinning && table.game?.first === seat);
      panel.classList.toggle('is-winner', completed?.winner === seat);
      const art = el('div', 'score-art');
      for (const card of player.commanders) if (card.image) { const img = el('img'); img.src = card.image; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.addEventListener('error', () => img.remove(), { once: true }); art.append(img); }
      const content = el('div', 'score-player'), name = el('div', 'score-player-name', label(player));
      const row = el('div', 'score-life-row');
      const minus = btn('', () => life(seat, -1), 'score-adjust'), plus = btn('', () => life(seat, 1), 'score-adjust');
      minus.append(lifeSymbol(false)); plus.append(lifeSymbol(true));
      minus.setAttribute('aria-label', SEATS[seat] + '减生命'); plus.setAttribute('aria-label', SEATS[seat] + '加生命');
      minus.disabled = plus.disabled = table.phase !== 'playing' || ending || spinning;
      const number = el('span', 'score-life', String(player.life)); number.setAttribute('aria-label', '生命'); number.dataset.digits = String(player.life).length;
      row.append(minus, number, plus); content.append(name, row, el('span', 'score-first', '先手'));
      if (table.phase === 'setup') content.append(el('span', 'score-setup-note', '长按选择统帅'));
      if (completed?.winner === seat) { const award = el('div', 'score-worn-award'); award.setAttribute('role', 'img'); award.setAttribute('aria-label', '赢家奖章'); award.append(winnerAward()); content.append(award); }
      panel.append(art, content); bindSeat(panel, seat); grid.append(panel);
    });
    grid.addEventListener('click', () => { if (menuOpen) setMenu(false); }); container.append(grid);
    if (!ending && table.phase === 'setup') container.append(btn('⋯', () => setMenu(!menuOpen), 'score-corner'));
    const center = btn(ending ? '' : spinning ? '抽签' : table.phase === 'setup' ? '开始' : '⋯', () => {
      if (ending || spinning) return;
      if (menuOpen) { setMenu(false); return; }
      if (table.phase === 'setup') start(); else setMenu(!menuOpen);
    }, 'score-center' + (ending ? ' score-award' : table.phase !== 'setup' ? ' is-compact' : ''));
    if (ending) center.append(winnerAward());
    center.setAttribute('aria-label', ending ? '拖动奖章到赢家面板' : table.phase === 'setup' ? '开始游戏' : '计分板菜单');
    center.disabled = spinning;
    container.append(center);
    if (!ending && !spinning) renderMenu();
    if (completed) renderResult(completed);
    if (ending) {
      container.append(el('div', 'score-end-shade'));
      for (const side of ['top', 'bottom']) {
        container.append(el('div', 'score-end-label is-' + side, endHint), btn('取消', cancelEnding, 'score-cancel is-' + side));
      }
      bindWinnerDrag(center);
    }
    const rotate = el('div', 'score-rotate'); rotate.append(el('strong', '', '横屏计分板'), el('p', '', '将手机横放在四位玩家中间'), btn('进入全屏', fullscreen), btn('返回', leave)); container.append(rotate);
  }
  function start() {
    if (spinning || table.phase === 'playing') return;
    const random = new Uint32Array(1); crypto.getRandomValues(random);
    const first = Math.floor(random[0] / 4294967296 * 4);
    if (!save(startTable(table, { first }))) return;
    void fullscreen(); spinning = true; let step = 0; spinIndex = -1; renderTable();
    const total = matchMedia('(prefers-reduced-motion:reduce)').matches ? 4 : 20 + first;
    const advance = () => {
      spinIndex = step % 4; container.querySelectorAll('.score-seat').forEach((panel, seat) => panel.classList.toggle('is-lit', seat === spinIndex)); step++;
      if (step < total) timer = setTimeout(advance, 60 + Math.pow(step / total, 3) * 200);
      else {
        spinIndex = first; container.querySelectorAll('.score-seat').forEach((panel, seat) => panel.classList.toggle('is-lit', seat === first));
        timer = setTimeout(() => { spinning = false; renderTable(); container.querySelector(`[data-seat="${first}"]`).classList.add('score-first-reveal'); }, 650);
      }
    }; advance();
  }
  function cancelEnding() { ending = false; clearDrag(); renderTable(); }
  function clearDrag() {
    if (gesture?.button) { gesture.button.classList.remove('is-carried'); gesture.button.style.left = ''; gesture.button.style.top = ''; }
    gesture = null; container.querySelectorAll('.is-drop').forEach(n => n.classList.remove('is-drop'));
  }
  function seatAt(x, y) { return document.elementFromPoint(x, y)?.closest('.score-seat'); }
  function bindWinnerDrag(button) {
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || gesture) return;
      const rect = button.getBoundingClientRect();
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, offsetX: event.clientX - rect.x - rect.width / 2, offsetY: event.clientY - rect.y - rect.height / 2, moved: false, button };
      button.setPointerCapture(event.pointerId); button.classList.add('is-carried'); event.preventDefault();
    });
    button.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      gesture.moved ||= Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 24;
      const bounds = container.getBoundingClientRect();
      button.style.left = `${event.clientX - bounds.left - gesture.offsetX}px`; button.style.top = `${event.clientY - bounds.top - gesture.offsetY}px`;
      const target = seatAt(event.clientX, event.clientY);
      container.querySelectorAll('.score-seat').forEach(n => n.classList.toggle('is-drop', n === target));
    });
    button.addEventListener('pointerup', event => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const moved = gesture.moved, target = seatAt(event.clientX, event.clientY), carried = button.getBoundingClientRect(); clearDrag();
      if (!moved || !target) { endHint = '拖动奖章，佩戴到赢家面板'; writeEndHint(); return; }
      try {
        const record = finishTable(table, Number(target.dataset.seat));
        const next = { ...table, phase: 'ended' };
        store.finish(record, next); table = next; ending = false; renderTable(); navigator.vibrate?.([30, 40, 60]);
        const award = container.querySelector('.score-worn-award');
        if (award && !matchMedia('(prefers-reduced-motion:reduce)').matches) {
          const worn = award.getBoundingClientRect(), sign = record.winner < 2 ? -1 : 1;
          const dx = sign * (carried.x + carried.width / 2 - worn.x - worn.width / 2), dy = sign * (carried.y + carried.height / 2 - worn.y - worn.height / 2);
          award.animate([{ transform: `translate(${dx}px,${dy}px) scale(${carried.width / worn.width}) rotate(0deg)` }, { transform: 'translate(0,0) scale(1) rotate(-10deg)' }], { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' });
        }
      } catch (error) { notify(error.message || '记录保存失败', 'error'); }
    });
    button.addEventListener('pointercancel', clearDrag); button.addEventListener('lostpointercapture', clearDrag);
  }
  function renderMenu() {
    const menu = el('nav', 'score-radial'); menu.setAttribute('aria-label', '计分板菜单操作'); menu.setAttribute('aria-hidden', 'true'); menu.inert = true;
    const options = [['退出记分', leave, 'exit'], ['重置计分板', resetTable, 'reset'], ['结束游戏', () => { setMenu(false); ending = true; endHint = '谁赢了？拖动奖章授予赢家'; renderTable(); }, 'finish']];
    for (const side of [1, -1]) options.forEach(([text, action, kind], index) => {
      const b = btn(text, action, 'score-orbit-button is-' + kind);
      b.style.setProperty('--orbit-x', `${(index - 1) * 112 * side}px`); b.style.setProperty('--orbit-y', `${(index === 1 ? -80 : -45) * side}px`);
      b.style.setProperty('--orbit-turn', side === 1 ? '180deg' : '0deg'); b.style.setProperty('--orbit-delay', `${index * 35}ms`);
      b.disabled = kind === 'finish' && table.phase !== 'playing'; b.tabIndex = -1; menu.append(b);
    }); container.append(menu);
    const center = container.querySelector('.score-center'); center.setAttribute('aria-expanded', 'false');
  }
  function resetTable() {
    setMenu(false);
    const panel = dialog('重置计分板');
    panel.append(el('p', 'score-reset-message', '清空当前对局和统帅设置，生命恢复 40。游戏记录和备注保留。'));
    const actions = el('div', 'score-dialog-actions');
    actions.append(btn('取消', closeDialog), btn('确认重置', () => {
      if (!save(freshTable())) return;
      clearTimeout(timer); spinning = false; spinIndex = -1; ending = false; clearDrag(); renderTable();
    }, 'button deck-danger'));
    panel.append(actions);
  }
  function setMenu(open) {
    if (ending || spinning) return;
    menuOpen = open;
    const menu = container.querySelector('.score-radial'); if (!menu) return;
    menu.classList.toggle('is-open', open); menu.inert = !open; menu.setAttribute('aria-hidden', String(!open));
    menu.querySelectorAll('button').forEach(b => { b.tabIndex = open ? 0 : -1; });
    container.classList.toggle('score-menu-open', open);
    const center = container.querySelector('.score-center'); center.textContent = open ? '×' : table.phase === 'setup' ? '开始' : '⋯'; center.setAttribute('aria-expanded', String(open)); center.setAttribute('aria-label', open ? '收起菜单' : table.phase === 'setup' ? '开始游戏' : '计分板菜单');
  }
  function renderResult(record) {
    for (const side of ['top', 'bottom']) {
      const result = el('section', 'score-result is-' + side);
      result.append(el('div', 'score-result-winner', label(record.players[record.winner]) + ' 获胜'));
      const actions = el('div', 'score-result-actions');
      actions.append(btn('再来一局', start, 'score-result-button is-primary'), btn(record.note ? '编辑备注' : '添加备注', () => editNote(record.id), 'score-result-button'));
      result.append(actions); container.append(result);
    }
  }
  function editNote(id) {
    setMenu(false);
    const record = store.records.find(item => item.record.id === id)?.record; if (!record) return;
    const panel = dialog('本局备注'), form = el('form'), input = el('textarea', 'score-note-input');
    input.value = record.note; input.maxLength = 2000; input.rows = 3; input.placeholder = '记录这局的亮点、关键回合…'; input.setAttribute('aria-label', '本局备注');
    const actions = el('div', 'score-dialog-actions'), save = btn('保存备注', () => {}); save.type = 'submit'; actions.append(save); form.append(input, actions); panel.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      try { store.annotate(id, input.value); closeDialog(); if (screen === 'history') renderHistory(); else renderTable(); }
      catch (error) { notify(error.message || '备注保存失败', 'error'); }
    }); input.focus();
  }
  function editPlayer(seat) {
    const player = table.players[seat], panel = dialog(player.name + ' · 统帅');
    let selected = [...player.commanders], controller, debounce, revision = 0;
    const form = el('form'), fields = el('div'), results = el('div', 'score-choices'), message = el('p', 'score-dialog-error');
    const actions = el('div', 'score-dialog-actions'); const saveButton = btn('保存', () => {}); saveButton.type = 'submit';
    const clear = btn('清除统帅', () => { selected = []; renderFields(); }); actions.append(clear, saveButton);
    form.append(fields, results, message, actions); panel.append(form);
    overlay.cleanup = () => { clearTimeout(debounce); controller?.abort(); revision++; };
    async function search(value, row) {
      controller?.abort(); controller = new AbortController(); const rev = ++revision;
      results.replaceChildren(); message.textContent = value.trim() ? '搜索中…' : ''; if (!value.trim()) return;
      try {
        let query = `(${value.trim()}) ${COMMANDER_QUERY}`;
        const rule = row === 1 ? commanderRule(selected[0]) : null;
        if (rule?.kind === 'named') query += ' name="' + rule.target.replace(/["\\]/g, '') + '"';
        else if (rule?.kind === 'choose-background') query += ' t:background';
        else if (rule?.kind === 'background') query += ' o:"Choose a Background"';
        else if (rule?.kind === 'companion') query += ' t:doctor';
        else if (rule?.kind === 'doctor') query += ' o:"Doctor\'s companion"';
        else if (rule?.kind === 'group') query += ' o:"' + rule.target.replace(/["\\]/g, '') + '"';
        else if (rule?.kind === 'partner') query += ' o:partner';
        const found = await catalog.search({ query, sort: 'edhrec', commanderOnly: true, limit: 40, signal: controller.signal });
        const candidates = await Promise.all(found.cards.slice(0, 16).map(c => catalog.detail(c.id)));
        if (rev !== revision || !overlay) return;
        const eligible = candidates.filter(commanderEligible).filter(c => row === 0 || commanderPairFits(selected[0], c));
        message.textContent = eligible.length ? '' : '没有匹配的统帅';
        for (const card of eligible) {
          const snapshot = commanderSnapshot(card), choice = btn('', () => {
            selected[row] = snapshot; if (row === 0) selected = selected.slice(0, 1);
            results.replaceChildren(); message.textContent = ''; renderFields();
          }, 'score-choice');
          choice.title = snapshot.name;
          if (snapshot.image) { const img = el('img'); img.src = snapshot.image; img.alt = ''; img.referrerPolicy = 'no-referrer'; choice.append(img); }
          choice.append(el('span', '', snapshot.zhName || snapshot.name)); results.append(choice);
        }
      } catch (error) { if (rev === revision && error.name !== 'AbortError') message.textContent = error.message; }
    }
    function renderFields() {
      controller?.abort(); revision++; fields.replaceChildren(); results.replaceChildren(); message.textContent = '';
      const pair = commanderRule(selected[0]);
      for (let row = 0; row < (pair ? 2 : 1); row++) {
        const name = el('label', '', row === 0 ? '统帅' : pair.kind === 'choose-background' ? '背景' : '第二张统帅');
        const input = el('input'); input.type = 'search'; input.placeholder = selected[row] ? selected[row].zhName || selected[row].name : '搜索中文或英文牌名';
        input.setAttribute('aria-label', row === 0 ? '搜索统帅' : '搜索第二张统帅'); input.autocomplete = 'off'; name.append(input); fields.append(name);
        if (selected[row]) fields.append(el('p', 'score-selected', '已选：' + (selected[row].zhName || selected[row].name)));
        input.addEventListener('input', () => { clearTimeout(debounce); controller?.abort(); revision++; debounce = setTimeout(() => search(input.value, row), 250); });
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (commanderRule(selected[0])?.kind === 'background' && !selected[1]) { message.textContent = '请为背景选择配对的统帅'; return; }
      if (selected[1] && !commanderPairFits(selected[0], selected[1])) { message.textContent = '这两张牌不能组成双统帅'; return; }
      if (save({ ...table, players: table.players.map((p, i) => i === seat ? { ...p, commanders: selected } : p) })) renderTable();
    });
    renderFields();
  }
  function renderHistory() {
    if (!table) return;
    closeDialog(); container.className = 'score-history'; container.replaceChildren();
    const heading = el('div', 'score-history-heading'); heading.append(el('h1', '', '游戏记录'), btn('返回其他功能', leave));
    container.append(heading, el('p', 'score-history-status', store.status));
    if (table.phase === 'playing') { const current = el('article', 'score-game'); current.append(el('h2', '', '正在进行'), el('p', 'score-game-time', '开始于 ' + date(table.game.startedAt)), el('p', '', table.players.map(label).join(' · ')), btn('继续计分', onOpenTable)); container.append(current); }
    for (const { record, pending } of store.records) {
      const game = el('article', 'score-game'); const minutes = Math.max(0, Math.round((Date.parse(record.endedAt) - Date.parse(record.startedAt)) / 60000));
      game.append(el('h2', '', date(record.startedAt)), el('p', 'score-game-time', `结束 ${date(record.endedAt)} · ${minutes} 分钟${pending ? ' · 待同步' : ''}`));
      const players = el('div', 'score-game-players');
      record.players.forEach((p, seat) => { const item = el('div', 'score-game-player' + (seat === record.winner ? ' is-winner' : '')); item.append(el('strong', '', label(p)), el('div', '', `${seat === record.winner ? '胜利 · ' : ''}生命 ${p.life}${seat === record.first ? ' · 先手' : ''}`)); players.append(item); });
      game.append(players);
      if (record.note) game.append(el('p', 'score-game-note', record.note));
      game.append(btn(record.note ? '编辑备注' : '添加备注', () => editNote(record.id), 'button score-history-note'));
      container.append(game);
    }
    if (!store.records.length && table.phase !== 'playing') container.append(el('p', 'score-history-empty', '暂无游戏记录'));
    if (store.more) container.append(btn('更早的记录', () => { void store.sync(true); }));
  }
  function leave() { onBack(); }
  function back() {
    if (!visible) return false;
    if (closeDialog()) return true;
    if (menuOpen) { setMenu(false); return true; }
    if (ending) { cancelEnding(); return true; }
    if (screen === 'history') { leave(); return true; }
    if (table.phase !== 'setup') { setMenu(true); return true; }
    leave(); return true;
  }
  document.addEventListener('keydown', event => {
    if (!visible) return;
    if (event.key === 'Escape') { event.preventDefault(); back(); }
    if (event.key === 'Tab' && overlay) {
      const nodes = [...overlay.querySelectorAll('button,input,textarea')].filter(n => !n.disabled), first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  window.addEventListener('popstate', () => {
    if (!visible || !historyManaged) return;
    historyManaged = false;
    if (overlay || menuOpen || ending) {
      back(); history.pushState({ ...history.state, tieyouScoreboard: true }, ''); historyManaged = true;
    } else leave();
  });
  window.addEventListener('online', () => { void store.ready.then(() => store.sync()).catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (visible && screen === 'table' && !document.hidden) void fullscreen(); });
  return {
    async open({ historyOnly = false } = {}) {
      visible = true; const revision = ++operation; container.hidden = false; container.className = 'score-history'; container.textContent = '正在读取计分板…';
      if (!window.tieyouAndroid && !historyManaged) { history.pushState({ ...history.state, tieyouScoreboard: true }, ''); historyManaged = true; }
      try {
        await store.ready; if (!visible || revision !== operation) return; table = store.table;
        if (historyOnly) { screen = 'history'; releaseScreen(); renderHistory(); void store.sync(); }
        else { screen = 'table'; renderTable(); if (window.TieyouTable) void fullscreen(); }
      }
      catch (error) { container.replaceChildren(el('p', '', error.message), btn('返回', leave)); }
    },
    close() { visible = false; operation++; clearTimeout(timer); spinning = false; ending = false; clearDrag(); closeDialog(); releaseScreen(); if (historyManaged) { historyManaged = false; history.back(); } }, back,
  };
}
