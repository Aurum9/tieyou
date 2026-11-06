import { DeckStore, defaultVersion, getVersion, findCardCandidates, getCommanderIdentity, validateDeck, parseDeckText, rowToEntry, exportDeckText, exportDeckBackup, parseDeckBackup } from './decks.js';

const zoneNames = { commander: '统帅', main: '主牌', considering: '候选牌' };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, handler, className = 'button button-quiet') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node; }
function field(label, control) { const node = el('label', 'deck-field'); node.append(el('span', '', label), control); return node; }
function input(value = '', type = 'text') { const node = el('input', 'deck-input'); node.type = type; node.value = value; return node; }
function select(options, value) { const node = el('select', 'deck-input'); for (const [id, label] of options) { const option = el('option', '', label); option.value = id; node.append(option); } node.value = value; return node; }
function quantityInput(value = 1) { const node = input(value, 'number'); node.min = '1'; node.max = '999'; node.step = '1'; node.setAttribute('aria-label', '数量'); return node; }
function printingName(version) { return `${String(version.set || '').toUpperCase()} · ${version.collectorNumber || '—'}${version.lang ? ` · ${version.lang}` : ''}`; }
function download(text, filename, type = 'text/plain') { const url = URL.createObjectURL(new Blob([text], { type })); const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function safeFilename(name) { return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'edh-decks'; }
function modal(title, { wide = false, onClose } = {}) {
  const previousFocus = document.activeElement;
  const overlay = el('div', 'deck-modal-overlay');
  const panel = el('section', `deck-modal${wide ? ' deck-modal-wide' : ''}`);
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
  const heading = el('h2', '', title); heading.id = `dialog-${Math.random().toString(36).slice(2)}`; panel.setAttribute('aria-labelledby', heading.id);
  const header = el('div', 'deck-modal-header');
  let closed = false;
  const close = () => { if (closed) return; closed = true; overlay.remove(); document.removeEventListener('keydown', keydown); previousFocus?.focus?.(); onClose?.(); };
  const closeButton = button('关闭', close); header.append(heading, closeButton); panel.append(header); overlay.append(panel);
  const keydown = event => {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button,input,select,textarea,a[href]')].filter(node => !node.disabled && node.offsetParent !== null);
      const first = focusable[0], last = focusable.at(-1);
      if (!focusable.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', keydown);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.body.append(overlay); queueMicrotask(() => closeButton.focus());
  return { panel, close, overlay };
}

export function initDeckUI({ container, cards = [], onInspect = () => {}, onNotify = () => {}, loadCards = async () => cards, onOpenCatalog = () => {}, onLibraryChange = () => {}, onPlaytest = () => {} }) {
  let index = new Map(cards.map(card => [card.id, card]));
  let loadingCards = null;
  let openingId = null;
  let openingError = null;
  let openRequest = 0;
  let selectedId = null;
  let groupBy = 'type';
  const identitySearchPreferences = new Map();
  const searchDrafts = new Map();
  const openModals = new Set();
  const store = new DeckStore({ onChange: updateStatus });
  function updateStatus() {
    for (const node of container.querySelectorAll('.deck-save-status')) { node.textContent = store.status.message; node.classList.toggle('has-error', store.status.state === 'error'); }
  }
  function notifyError(error, target) { if (target) { target.textContent = error.message; target.hidden = false; } store.status = { state: 'error', message: `操作未完成：${error.message}` }; updateStatus(); onNotify(error.message, 'error'); }
  function run(action, { success, refresh = true, errorTarget } = {}) {
    try { const result = action(); if (refresh) render(); onLibraryChange(); if (success) onNotify(success, 'success'); return result; }
    catch (error) { notifyError(error, errorTarget); return null; }
  }
  function setCards(nextCards) { cards = nextCards; index = new Map(cards.map(card => [card.id, card])); }
  async function ensureCards() {
    if (cards.length) return cards;
    if (!loadingCards) loadingCards = (async () => {
      const loaded = await loadCards();
      if (!Array.isArray(loaded) || !loaded.length) throw new Error('卡牌数据尚未载入，请重试');
      setCards(loaded); return cards;
    })().finally(() => { loadingCards = null; });
    return loadingCards;
  }
  async function openDeck(id) {
    if (!store.get(id)) { onNotify('卡组已不存在，请重新选择', 'error'); return false; }
    const request = ++openRequest;
    openingId = id; openingError = null; render();
    try {
      await ensureCards();
      if (request !== openRequest) return false;
      if (!store.get(id)) throw new Error('卡组已不存在，请返回卡组库重新选择');
      openingId = null; selectedId = id; render(); return true;
    } catch (error) {
      if (request !== openRequest) return false;
      openingError = error; render(); onNotify(error.message, 'error'); return false;
    }
  }
  function dialog(title, options = {}) {
    const originalClose = options.onClose;
    const current = modal(title, { ...options, onClose: () => { openModals.delete(current); originalClose?.(); } }); openModals.add(current); return current;
  }
  function status() { const node = el('p', `deck-save-status${store.status.state === 'error' ? ' has-error' : ''}`, store.status.message); node.setAttribute('role', 'status'); return node; }
  function createDialog() {
    const current = dialog('新建卡组'); const name = input(''); name.placeholder = '例如：森林里的小小计划'; name.maxLength = 200;
    const error = el('p', 'deck-form-error'); error.hidden = true;
    const form = el('form', 'deck-stack'); form.append(field('卡组名称', name), error);
    const submit = button('创建卡组', () => {}, 'button button-primary'); submit.type = 'submit';
    form.append(submit); form.addEventListener('submit', event => {
      event.preventDefault(); const deck = run(() => store.importEntries(name.value.trim() || '未命名卡组', []), { refresh: false, errorTarget: error });
      if (deck) { current.close(); onNotify('卡组已创建', 'success'); void openDeck(deck.id); }
    }); current.panel.append(form); queueMicrotask(() => name.focus());
  }
  function renderLibrary() {
    const header = el('div', 'deck-page-heading'); const title = el('div'); title.append(el('p', 'deck-eyebrow', 'YOUR COLLECTION'), el('h1', '', '卡组库'), el('p', 'deck-muted', '从一个想法，到你的下一套指挥官卡组。'));
    const actions = el('div', 'deck-actions'); actions.append(button('导入牌表', importDialog), button('备份全部', () => exportDialog()), button('＋ 新建卡组', createDialog, 'button button-primary'));
    header.append(title, actions); container.append(header, status());
    if (store.loadBlocked) {
      const recovery = el('div', 'deck-recovery'); recovery.append(el('strong', '', '本地数据读取失败，写入已暂停'), el('p', 'deck-muted', '原始内容仍保留在浏览器中。请先下载原始数据，再决定是否重建空白卡组库。'));
      if (store.recoveryRaw !== null) recovery.append(button('下载原始数据', () => download(store.recoveryRaw, 'edh-library-recovery.txt')), button('保留副本并重建', () => {
        const current = dialog('重建本地卡组库');
        current.panel.append(el('p', 'deck-muted', '将先在浏览器保留原始数据恢复副本，再建立空白卡组库。原始文件也可先下载到设备，供后续检查和修复。'), button('下载原始数据', () => download(store.recoveryRaw, 'edh-library-recovery.txt')), button('确认保留副本并重建', () => { const result = run(() => store.rebuildAfterCorruption(), { refresh: false }); if (result) { current.close(); render(); onNotify('已保留恢复副本并重建本地库', 'success'); } }, 'button deck-danger'));
      }));
      container.append(recovery);
    }
    const decks = store.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!decks.length) {
      const empty = el('div', 'deck-empty'); empty.append(el('div', 'deck-empty-mark', '♧'), el('h2', '', '第一套卡组，从这里开始'), el('p', 'deck-muted', '新建空白卡组，或导入一份已有牌表。你的卡组会保存在当前浏览器。'), button('新建我的卡组', createDialog, 'button button-primary')); container.append(empty);
    } else {
      const grid = el('div', 'deck-library-grid');
      for (const deck of decks) {
        const count = deck.entries.filter(entry => entry.zone !== 'considering').reduce((sum, entry) => sum + entry.quantity, 0);
        const consideringCount = deck.entries.filter(entry => entry.zone === 'considering').reduce((sum, entry) => sum + entry.quantity, 0);
        const tile = el('article', 'deck-tile');
        const commander = deck.entries.find(entry => entry.zone === 'commander'); const card = index.get(commander?.cardId);
        const art = card ? getVersion(card, commander.versionId)?.image || card.image : '';
        const banner = el('div', 'deck-tile-art');
        if (art && /^https?:\/\//.test(art)) { const img = el('img'); img.src = art; img.loading = 'lazy'; img.alt = ''; banner.append(img); }
        else banner.append(el('span', '', '♧'));
        const open = button(deck.name, () => { void openDeck(deck.id); }, 'deck-title-button');
        const commanderLabel = card?.zhName || card?.name || (commander ? (cards.length ? '当前卡库缺少统帅信息' : '统帅信息将在编辑时加载') : '尚未设置统帅');
        const body = el('div', 'deck-tile-body'); body.append(open, el('p', 'deck-muted deck-clamp', commanderLabel), el('p', 'deck-tile-count', `${count} / 100 张 · ${consideringCount} 张候选`));
        if (deck.description) body.append(el('p', 'deck-muted deck-clamp', deck.description));
        const footer = el('div', 'deck-tile-footer'); footer.append(el('span', 'deck-muted', new Date(deck.updatedAt).toLocaleDateString('zh-CN')), button('编辑 →', () => { void openDeck(deck.id); }));
        body.append(footer); tile.append(banner, body); grid.append(tile);
      }
      container.append(grid);
    }
    const deleted = store.deleted();
    if (deleted.length) {
      const section = el('details', 'deck-trash'); section.append(el('summary', '', `最近删除 · ${deleted.length} 套`));
      for (const item of deleted.slice().reverse()) { const row = el('div', 'deck-trash-row'); row.append(el('span', '', item.deck.name), button('恢复', () => run(() => store.restore(item.deck.id), { success: '卡组已恢复' }))); section.append(row); }
      container.append(section);
    }
    container.append(el('p', 'deck-storage-note', '本地存储随浏览器与设备分别保存。清理网站数据前，请下载完整 JSON 备份。'));
  }
  function saveEntry(entryId, changes, errorTarget) {
    return run(() => { const deck = store.get(selectedId); const entry = deck.entries.find(item => item.id === entryId); Object.assign(entry, changes); return store.save(deck); }, { errorTarget });
  }
  function renderEditor(deck) {
    const back = button('← 卡组库', showLibrary); container.append(back);
    const header = el('div', 'deck-page-heading'); const title = el('div'); title.append(el('p', 'deck-eyebrow', 'DECK WORKSHOP'), el('h1', '', deck.name));
    const actions = el('div', 'deck-actions'); actions.append(button('手动测试 ↗', () => { const fresh = store.get(deck.id); if (fresh) onPlaytest(fresh); else onNotify('卡组已不存在，请重新选择', 'error'); }, 'button button-primary'), button('复制', () => { const copy = run(() => store.copy(deck.id), { refresh: false }); if (copy) { selectedId = copy.id; render(); onNotify('已创建独立副本', 'success'); } }), button('导出', () => exportDialog(deck)), button('删除', () => deleteDialog(deck), 'button deck-danger'));
    header.append(title, actions); container.append(header, status());
    const metadata = el('details', 'deck-metadata'); metadata.append(el('summary', '', '编辑名称与说明'));
    const name = input(deck.name); name.maxLength = 200; const description = el('textarea', 'deck-input'); description.value = deck.description; description.rows = 2;
    const metaError = el('p', 'deck-form-error'); metaError.hidden = true;
    metadata.append(field('卡组名称', name), field('卡组说明', description), metaError, button('保存信息', () => run(() => store.save({ ...store.get(deck.id), name: name.value.trim(), description: description.value }), { success: '卡组信息已保存', errorTarget: metaError }), 'button button-primary')); container.append(metadata);
    const stats = validateDeck(deck, cards); const statsGrid = el('div', 'deck-stats');
    for (const [value, label] of [[`${stats.count} / 100`, '正式卡组'], [stats.commanderCount, '统帅'], [stats.consideringCount, '候选牌'], [stats.colorIdentity.join(' · ') || '—', '统帅标识色']]) { const box = el('div'); box.append(el('strong', '', value), el('span', '', label)); statsGrid.append(box); }
    container.append(statsGrid);
    const checks = el('details', `deck-checks${stats.issues.some(issue => issue.severity === 'error') ? ' has-issues' : ''}`);
    checks.append(el('summary', '', stats.issues.length ? `基础组牌检查 · ${stats.issues.length} 项待处理` : '基础检查未发现问题 · 特殊规则请人工核对'));
    const list = el('ul'); for (const issue of stats.issues) list.append(el('li', issue.severity === 'error' ? 'deck-check-error' : 'deck-check-warning', issue.message));
    checks.append(list, el('p', 'deck-muted', '此处仅检查数量、重复、标识色、禁牌和可识别的统帅资格。特殊组合及牌面限制仍需人工核对。问题不影响草稿保存。')); container.append(checks);
    renderAddSearch(deck);
    const listHeader = el('div', 'deck-list-heading'); listHeader.append(el('h2', '', '卡组牌表'));
    const grouping = select([['type', '按卡牌类型'], ['mana', '按法术力值'], ['category', '按个人分类']], groupBy); grouping.setAttribute('aria-label', '牌表整理方式'); grouping.addEventListener('change', () => { groupBy = grouping.value; render(); }); listHeader.append(grouping); container.append(listHeader);
    if (!deck.entries.length) { const empty = el('div', 'deck-empty deck-empty-small'); empty.append(el('h3', '', '先加入一位统帅'), el('p', 'deck-muted', '使用上方名称或系列＋编号搜索，也可从卡查结果直接加入。')); container.append(empty); }
    for (const zone of ['commander', 'main', 'considering']) {
      const entries = deck.entries.filter(entry => entry.zone === zone); if (!entries.length) continue;
      const section = el('section', 'deck-zone'); const total = entries.reduce((sum, entry) => sum + entry.quantity, 0); section.append(el('h2', 'deck-zone-title', `${zoneNames[zone]} · ${total}`));
      const groups = new Map();
      for (const entry of entries) {
        const card = index.get(entry.cardId);
        let key = '未分类';
        if (groupBy === 'mana') key = `法术力值 ${card?.manaValue ?? '未知'}`;
        else if (groupBy === 'category') key = entry.categories.length ? entry.categories.join(' / ') : '未分类';
        else key = card ? shortType(card) : '当前卡库缺失';
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry);
      }
      for (const [key, entries] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN', { numeric: true }))) {
        section.append(el('h3', 'deck-group-title', `${key} · ${entries.reduce((sum, entry) => sum + entry.quantity, 0)}`));
        const rows = el('div', 'deck-entries');
        for (const entry of entries.sort((a, b) => (index.get(a.cardId)?.name || a.cardId).localeCompare(index.get(b.cardId)?.name || b.cardId))) rows.append(entryRow(entry));
        section.append(rows);
      }
      container.append(section);
    }
  }
  function shortType(card) {
    const type = card.faces?.[0]?.typeLine || card.typeLine || '';
    for (const [english, chinese] of [['Creature', '生物'], ['Land', '地'], ['Planeswalker', '鹏洛客'], ['Instant', '瞬间'], ['Sorcery', '法术'], ['Artifact', '神器'], ['Enchantment', '结界'], ['Battle', '战役']]) if (type.includes(english)) return chinese;
    return '其他';
  }
  function entryRow(entry) {
    const card = index.get(entry.cardId); const wrapper = el('article', 'deck-entry'); const row = el('div', 'deck-entry-main');
    const title = el('div', 'deck-entry-title'); title.append(button(card?.zhName || card?.name || `缺失卡牌 ${entry.cardId}`, () => card && onInspect(card), 'deck-card-link'));
    title.append(el('small', 'deck-muted', card ? `${card.name} ${card.manaCost || ''}` : '请保留 JSON 备份并更新卡库'));
    const quantity = quantityInput(entry.quantity); quantity.addEventListener('change', () => saveEntry(entry.id, { quantity: Number(quantity.value) }));
    const zone = select(Object.entries(zoneNames), entry.zone); zone.setAttribute('aria-label', '牌张分区'); zone.addEventListener('change', () => saveEntry(entry.id, { zone: zone.value }));
    const versions = card?.versions?.length ? card.versions.map(version => [version.id, printingName(version)]) : [[entry.versionId, '默认版本']];
    if (!versions.some(([id]) => id === entry.versionId)) versions.unshift([entry.versionId, '当前版本缺失']);
    const printing = select(versions, entry.versionId); printing.setAttribute('aria-label', '印刷版本'); printing.addEventListener('change', () => saveEntry(entry.id, { versionId: printing.value }));
    const remove = button('移除', () => run(() => { const deck = store.get(selectedId); deck.entries = deck.entries.filter(item => item.id !== entry.id); return store.save(deck); })); remove.setAttribute('aria-label', `移除 ${card?.zhName || card?.name || '卡牌'}`);
    row.append(title, quantity, zone, printing, remove); wrapper.append(row);
    const details = el('details', 'deck-entry-details'); details.append(el('summary', '', entry.categories.length || entry.notes ? `分类 / 备注${entry.categories.length ? ` · ${entry.categories.join('、')}` : ''}` : '分类 / 备注'));
    const categories = input(entry.categories.join('，')); categories.placeholder = '例如：加速，核心，待替换'; const notes = el('textarea', 'deck-input'); notes.value = entry.notes; notes.rows = 2;
    details.append(field('个人分类（逗号分隔）', categories), field('备注', notes), button('保存分类与备注', () => saveEntry(entry.id, { categories: categories.value.split(/[,，]/).map(item => item.trim()).filter(Boolean), notes: notes.value }), 'button button-quiet')); wrapper.append(details); return wrapper;
  }
  function renderAddSearch(deck) {
    const section = el('section', 'deck-add-section'); section.append(el('h2', '', '添加卡牌'));
    const draft = searchDrafts.get(deck.id) || { query: '' }; searchDrafts.set(deck.id, draft);
    const form = el('form', 'deck-add-form'); const query = input(draft.query); query.placeholder = '中文 / 英文牌名，或系列＋编号（如 cmm 396）'; query.setAttribute('aria-label', '搜索要加入的卡牌'); query.autocomplete = 'off';
    const advanced = button('高级搜索 ↗', () => onOpenCatalog({ deckId: deck.id, query: query.value.trim(), restrictIdentity: restrictIdentity.checked }));
    form.append(query, advanced); section.append(form);
    const commanderIdentity = getCommanderIdentity(deck, cards);
    const restrictIdentity = input('', 'checkbox'); restrictIdentity.checked = commanderIdentity !== null && identitySearchPreferences.get(deck.id) !== false; restrictIdentity.disabled = commanderIdentity === null;
    const identityLabel = el('label', 'deck-check-label'); identityLabel.append(restrictIdentity, el('span', '', '仅显示主将标识色内的牌'));
    const identityHint = el('p', 'deck-muted');
    if (commanderIdentity === null) identityHint.textContent = deck.entries.some(entry => entry.zone === 'commander') ? '主将标识色数据暂不可用，当前搜索不限标识色。' : '设置主将后，可以自动按主将标识色限制搜索。当前搜索不限标识色。';
    else {
      const colorNames = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿' };
      identityHint.textContent = `主将标识色：${commanderIdentity.map(color => colorNames[color]).join('、') || '无色'}。筛选范围包含${[...commanderIdentity.map(color => colorNames[color]), '无色'].join('、')}标识的牌。`;
    }
    section.append(identityHint, identityLabel);
    const results = el('div', 'deck-add-results'); section.append(results);
    function showCandidates() {
      results.replaceChildren();
      if (!query.value.trim()) return;
      const allCandidates = findCardCandidates(query.value, cards, { colorIdentity: restrictIdentity.checked ? commanderIdentity : null });
      const candidates = allCandidates.slice(0, 8);
      if (!candidates.length) { results.append(el('p', 'deck-muted', restrictIdentity.checked ? '主将标识色范围内没有找到对应卡牌。可调整牌名，或取消标识色限制继续查找。' : '没有找到对应卡牌。可以输入完整牌名，或使用“系列代码 编号”。')); return; }
      if (allCandidates.length > 8) results.append(el('p', 'deck-muted', '以下为前 8 个匹配，请补充关键词，或进入高级搜索查看更多。'));
      const printingQuery = query.value.trim().toLowerCase().match(/^([a-z0-9]+)\s*[:/#\s]\s*(\S+)$/);
      for (const card of candidates) {
        const row = el('div', 'deck-search-result'); const name = el('div'); name.append(button(card.zhName || card.name, () => onInspect(card), 'deck-card-link'), el('small', 'deck-muted', card.name));
        const version = printingQuery ? card.versions?.find(item => item.set.toLowerCase() === printingQuery[1] && String(item.collectorNumber).toLowerCase() === printingQuery[2]) : null;
        row.append(name, button('＋ 加入', () => quickAddCard(card, version, deck.id), 'button button-quiet')); results.append(row);
      }
    }
    let suggestionTimer;
    query.addEventListener('input', () => {
      draft.query = query.value; clearTimeout(suggestionTimer);
      suggestionTimer = setTimeout(() => { if (query.isConnected) showCandidates(); }, 200);
    });
    query.addEventListener('change', () => { draft.query = query.value; clearTimeout(suggestionTimer); showCandidates(); });
    form.addEventListener('submit', event => { event.preventDefault(); draft.query = query.value; clearTimeout(suggestionTimer); showCandidates(); });
    restrictIdentity.addEventListener('change', () => { identitySearchPreferences.set(deck.id, restrictIdentity.checked); if (query.value.trim()) showCandidates(); });
    showCandidates();
    container.append(section);
  }
  function quickAddCard(card, version, deckId = selectedId) {
    if (!deckId || !store.get(deckId)) { onNotify('目标卡组已不存在，请重新选择卡组', 'error'); return false; }
    const versionId = typeof version === 'string' ? version : version?.id || defaultVersion(card);
    const updated = run(() => store.addCard(deckId, card, versionId, 'main', 1));
    if (!updated) return false;
    onNotify(`已加入「${updated.name}」主牌区`, 'success'); return true;
  }
  async function addCard(card, version, preferredId = selectedId) {
    return new Promise(resolve => {
      let didAdd = false;
      const current = dialog(`加入 ${card.zhName || card.name}`, { onClose: () => resolve(didAdd) });
      const decks = store.list(); const options = decks.map(deck => [deck.id, deck.name]); options.push(['__new__', '＋ 新建卡组']);
      const target = select(options, preferredId && decks.some(deck => deck.id === preferredId) ? preferredId : decks[0]?.id || '__new__');
      const newName = input('未命名卡组'); newName.maxLength = 200; const newNameField = field('新卡组名称', newName); newNameField.hidden = target.value !== '__new__'; target.addEventListener('change', () => { newNameField.hidden = target.value !== '__new__'; });
      const zone = select(Object.entries(zoneNames), 'main'); const quantity = quantityInput(1);
      const versionOptions = card.versions?.length ? card.versions.map(printing => [printing.id, printingName(printing)]) : [[card.id, '默认版本']];
      const printing = select(versionOptions, typeof version === 'string' ? version : version?.id || defaultVersion(card));
      const form = el('form', 'deck-stack'); const error = el('p', 'deck-form-error'); error.hidden = true;
      form.append(field('目标卡组', target), newNameField, field('加入分区', zone), field('数量', quantity), field('印刷版本', printing), error);
      const submit = button('加入卡组', () => {}, 'button button-primary'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const updated = run(() => {
          const amount = Number(quantity.value);
          if (!Number.isInteger(amount) || amount < 1 || amount > 999) throw new Error('数量须为 1–999 的整数');
          if (target.value === '__new__') return store.importEntries(newName.value.trim() || '未命名卡组', [{ id: 'new', cardId: card.id, versionId: printing.value, quantity: amount, zone: zone.value, categories: [], notes: '' }]);
          return store.addCard(target.value, card, printing.value, zone.value, amount);
        }, { refresh: false, errorTarget: error });
        if (updated) { didAdd = true; selectedId = updated.id; current.close(); render(); onNotify(`已加入「${updated.name}」`, 'success'); }
      }); current.panel.append(form);
    });
  }
  function deleteDialog(deck) {
    const current = dialog('将卡组移到最近删除');
    current.panel.append(el('p', '', `「${deck.name}」会保留在本地的“最近删除”中，可随时恢复。`), button('移到最近删除', () => { const result = run(() => { store.remove(deck.id); return true; }, { refresh: false }); if (result) { selectedId = null; current.close(); render(); onNotify('卡组已移到最近删除，可在卡组库恢复', 'success'); } }, 'button deck-danger'));
  }
  function exportDialog(deck) {
    const decks = deck ? [store.get(deck.id)] : store.list();
    if (!decks.length) { onNotify('当前没有可备份的卡组', 'info'); return; }
    const current = dialog(deck ? '导出卡组' : '备份全部卡组', { wide: true });
    const format = select(deck ? [['json', '完整 JSON 备份'], ['text', '英文文本牌表'], ['zh', '中文文本牌表']] : [['json', '完整 JSON 备份']], 'json');
    const output = el('textarea', 'deck-input deck-code'); output.rows = 14; output.readOnly = true;
    const error = el('p', 'deck-form-error'); error.hidden = true;
    const refresh = () => { try { output.value = format.value === 'json' ? exportDeckBackup(decks) : exportDeckText(decks[0], cards, { chinese: format.value === 'zh' }); error.hidden = true; } catch (err) { notifyError(err, error); output.value = ''; } }; format.addEventListener('change', refresh); refresh();
    const actions = el('div', 'deck-actions'); actions.append(button('下载文件', () => { if (!output.value) return; download(output.value, `${safeFilename(deck?.name || '全部卡组备份')}.${format.value === 'json' ? 'json' : 'txt'}`, format.value === 'json' ? 'application/json' : 'text/plain'); }, 'button button-primary'), button('复制内容', async () => { try { await navigator.clipboard.writeText(output.value); onNotify('导出内容已复制', 'success'); } catch { output.focus(); output.select(); onNotify('请使用系统复制操作复制已选中的内容', 'info'); } }));
    current.panel.append(el('p', 'deck-muted', `共 ${decks.length} 套卡组。JSON 保留版本、分区、分类和备注。文本保留数量、牌名、分区与版本。`), field('格式', format), output, error, actions);
  }
  async function importDialog() {
    const current = dialog('导入牌表与备份', { wide: true });
    const loading = el('p', 'deck-muted', '正在加载卡牌数据，以检查牌名和版本…'); current.panel.append(loading);
    try { await ensureCards(); }
    catch (error) {
      loading.textContent = `卡牌数据加载失败：${error.message}`;
      current.panel.append(button('重新加载', () => { current.close(); void importDialog(); }, 'button button-primary')); onNotify(error.message, 'error'); return;
    }
    if (!openModals.has(current)) return;
    loading.remove();
    const format = select([['text', '文本牌表'], ['json', '完整 JSON 备份']], 'text');
    const name = input('导入的卡组'); name.maxLength = 200; const nameField = field('新卡组名称', name);
    const file = input('', 'file'); file.accept = '.json,.txt,.dec,.dek,text/plain,application/json';
    const source = el('textarea', 'deck-input deck-code'); source.rows = 10; source.placeholder = '[Commander]\n1 你的统帅牌名\n\n[Main]\n1 Sol Ring\n1 Command Tower (CMM) 396\n\n[Considering]\n1 Counterspell'; source.setAttribute('aria-label', '导入内容');
    const hint = el('p', 'deck-muted', '每行填写“数量 牌名”，支持中文、英文及可选的 (系列代码) 编号。仅创建新卡组，现有卡组会保留。');
    const error = el('p', 'deck-form-error'); error.hidden = true; const preview = el('div', 'deck-import-preview');
    let textRows = null, jsonPreview = null;
    const clearPreview = () => { textRows = null; jsonPreview = null; preview.replaceChildren(); commitButton.disabled = true; error.hidden = true; };
    source.addEventListener('input', clearPreview); format.addEventListener('change', () => { nameField.hidden = format.value === 'json'; clearPreview(); });
    file.addEventListener('change', async () => { const selected = file.files?.[0]; if (!selected) return; if (selected.size > 10_000_000) { notifyError(new Error('导入文件需小于 10 MB'), error); return; } try { source.value = await selected.text(); format.value = selected.name.toLowerCase().endsWith('.json') || source.value.trim().startsWith('{') ? 'json' : 'text'; nameField.hidden = format.value === 'json'; clearPreview(); } catch (err) { notifyError(err, error); } });
    function refreshPreview() {
      preview.replaceChildren();
      if (jsonPreview) {
        preview.append(el('h3', '', `将新增 ${jsonPreview.decks.length} 套卡组`));
        for (const deck of jsonPreview.decks) preview.append(el('p', '', `${deck.name} · ${deck.entries.reduce((sum, entry) => sum + entry.quantity, 0)} 张（含候选）`));
        commitButton.disabled = false; return;
      }
      if (!textRows) return;
      const ready = textRows.filter(row => row.status === 'ready' && !row.skipped).length; const unresolved = textRows.filter(row => row.status !== 'ready' && !row.skipped).length; const skipped = textRows.filter(row => row.skipped).length;
      preview.append(el('h3', '', `${ready} 行可导入 · ${unresolved} 行待处理 · ${skipped} 行明确跳过`));
      for (const row of textRows) {
        const line = el('div', `deck-import-row${row.status !== 'ready' && !row.skipped ? ' has-error' : ''}`);
        const title = el('div', 'deck-import-row-heading'); title.append(el('strong', '', `第 ${row.line} 行 · ${zoneNames[row.zone]}`), el('span', '', row.skipped ? '已跳过' : row.message));
        const edit = input(row.raw); edit.setAttribute('aria-label', `修正第 ${row.line} 行`);
        const actions = el('div', 'deck-actions');
        actions.append(button('应用修正', () => {
          const parsed = parseDeckText(`[${row.zone}]\n${edit.value}`, cards).rows;
          if (parsed.length !== 1) { notifyError(new Error('每个修正项必须包含一行牌表内容'), error); return; }
          const replacement = { ...parsed[0], line: row.line, skipped: false }; Object.assign(row, replacement); refreshPreview();
        }));
        if (row.status === 'version-missing') actions.append(button('使用默认版本', () => { row.versionId = defaultVersion(index.get(row.cardId)); row.status = 'ready'; row.message = '已明确使用默认版本'; refreshPreview(); }));
        if (row.status === 'ambiguous') {
          const chooser = select([['', '选择卡牌'], ...row.candidates.map(id => { const card = index.get(id); return [id, `${card.zhName || card.name} · ${card.name} · ${id.slice(0, 8)}`]; })], '');
          chooser.setAttribute('aria-label', `解决第 ${row.line} 行牌名歧义`); chooser.addEventListener('change', () => { if (!chooser.value) return; row.cardId = chooser.value; row.versionId = defaultVersion(index.get(chooser.value)); row.status = 'ready'; row.message = '已选择卡牌与默认版本'; refreshPreview(); }); actions.append(chooser);
        }
        const skip = input('', 'checkbox'); skip.checked = Boolean(row.skipped); skip.addEventListener('change', () => { row.skipped = skip.checked; refreshPreview(); }); const skipLabel = el('label', 'deck-check-label'); skipLabel.append(skip, el('span', '', '跳过此行')); actions.append(skipLabel);
        line.append(title, edit, actions); preview.append(line);
      }
      commitButton.disabled = unresolved > 0 || ready === 0;
    }
    const previewButton = button('检查并预览', () => {
      error.hidden = true;
      try {
        if (format.value === 'json') { jsonPreview = parseDeckBackup(source.value, cards); textRows = null; }
        else { textRows = parseDeckText(source.value, cards).rows; jsonPreview = null; if (!textRows.length) throw new Error('没有可导入的牌表行'); }
        refreshPreview();
      } catch (err) { textRows = null; jsonPreview = null; preview.replaceChildren(); commitButton.disabled = true; notifyError(err, error); }
    }, 'button button-primary');
    const commitButton = button('确认新增导入', () => {
      const imported = run(() => {
        if (jsonPreview) return store.importBackup(source.value, { cards });
        if (!textRows || textRows.some(row => !row.skipped && row.status !== 'ready')) throw new Error('请先解决或明确跳过所有待处理行');
        const entries = textRows.filter(row => !row.skipped).map(rowToEntry);
        if (!entries.length) throw new Error('至少保留一行卡牌');
        return [store.importEntries(name.value.trim() || '导入的卡组', entries)];
      }, { refresh: false, errorTarget: error });
      if (imported) { selectedId = imported.length === 1 ? imported[0].id : null; current.close(); render(); onNotify(`已新增 ${imported.length} 套卡组`, 'success'); }
    }, 'button button-primary'); commitButton.disabled = true;
    const actions = el('div', 'deck-actions'); actions.append(previewButton, commitButton);
    current.panel.append(field('输入格式', format), nameField, field('选择本地文件（可选）', file), hint, source, error, actions, preview);
  }
  function render() {
    container.replaceChildren();
    if (openingId) {
      const pendingId = openingId;
      container.append(button('← 卡组库', showLibrary), el('h1', '', store.get(pendingId)?.name || '卡组编辑'));
      const message = el('p', openingError ? 'deck-form-error' : 'deck-muted', openingError ? `卡牌数据加载失败：${openingError.message}` : '正在加载卡牌数据…'); message.setAttribute('role', 'status'); container.append(message);
      if (openingError) container.append(button('重新加载', () => { void openDeck(pendingId); }, 'button button-primary'));
      return;
    }
    const deck = selectedId ? store.get(selectedId) : null;
    if (deck) renderEditor(deck); else { selectedId = null; renderLibrary(); }
  }
  function showLibrary() { ++openRequest; openingId = null; openingError = null; selectedId = null; render(); }
  render();
  return { render, addCard, quickAddCard, showLibrary, setCards, openDeck, listDecks: () => store.list(), getDeck: id => store.get(id), getSelectedDeckId: () => selectedId, destroy: () => { ++openRequest; for (const current of [...openModals]) current.close(); container.replaceChildren(); } };
}
