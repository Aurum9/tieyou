import { DeckStore, defaultVersion, getVersion, findCardCandidates, getCommanderIdentity, validateDeck, parseDeckText, rowToEntry, exportDeckText, exportDeckBackup, parseDeckBackup } from './decks.js';
import { createDeckSync, deviceDeckStorageKey } from './deck-sync.js';
import { createDeckAnalysis } from './deck-analysis-ui.js';
import { getDeckCategories, getDeckEntryCategory, groupDeckEntries } from './deck-editor-groups.js';
import { DECK_SORT_OPTIONS, getDeckEditorPreferences, createDeckEntryComparator, defaultSortDirection, sortDirectionLabel } from './deck-editor-sort.js';
import { applyDeckCardColor, createDeckCardImage, createDeckPriceBadge } from './deck-editor-views.js';
import { createDeckEditorDrag } from './deck-editor-drag.js';
import { commanderScopeQuery, deckTagQuery } from './deck-target.js';
import { normalizeText, searchCards } from './search.js';
import { manaCost } from './mana-symbols.js';
import { drawGuideMark, createDeckDemo } from './deck-onboarding.js';

const zoneNames = { commander: '统帅', main: '主牌', considering: '候选牌' };
const editorZones = { commander: '指挥官', main: '主牌', considering: '备牌' };
const deckViews = [['text', '文本'], ['cards', '卡图'], ['stack', '叠放']];
const entryIssueLabels = {
  duplicate: '重复',
  quantity: '数量无效',
  'missing-card': '卡库缺失',
  banned: '禁牌',
  'not-legal': '赛制不可用',
  'color-identity': '超出标识色',
  'commander-ineligible': '不可用作统帅',
};
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, handler, className = 'button button-quiet') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node; }
function field(label, control) { const node = el('label', 'deck-field'); node.append(el('span', '', label), control); return node; }
function input(value = '', type = 'text') { const node = el('input', 'deck-input'); node.type = type; node.value = value; return node; }
function select(options, value) { const node = el('select', 'deck-input'); for (const [id, label] of options) { const option = el('option', '', label); option.value = id; node.append(option); } node.value = value; return node; }
function quantityInput(value = 1) { const node = input(value, 'number'); node.min = '1'; node.max = '999'; node.step = '1'; node.setAttribute('aria-label', '数量'); return node; }
function printingName(version) { return `${String(version.set || '').toUpperCase()} · ${version.collectorNumber || '—'}${version.lang ? ` · ${version.lang}` : ''}`; }
function dragPreview(card, version, name) {
  return { name, image: version?.faceImages?.[0] || version?.image || card?.image || card?.faces?.[0]?.image };
}
function download(text, filename, type = 'text/plain') {
  if (globalThis.tieyouAndroid && globalThis.TieyouDeckFiles) {
    globalThis.TieyouDeckFiles.save(filename, text);
    return;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
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
      const focusable = [...panel.querySelectorAll('button,input,select,textarea,summary,a[href]')].filter(node => !node.disabled && node.offsetParent !== null);
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

export function initDeckUI({ container, cards = [], onInspect = () => {}, onNotify = () => {}, loadCards = async () => cards, loadDeckCards, loadCardsByIds, findCandidates, resolveDeckText, loadCardDetails, renderManaCost = manaCost, onOpenCatalog = () => {}, onLibraryChange = () => {}, onPlaytest = () => {}, syncDeckLibrary = false }) {
  let index = new Map(cards.map(card => [card.id, card]));
  let loadingCards = null;
  let openingId = null;
  let openingError = null;
  let openRequest = 0;
  let selectedId = null;
  let analysisOpen = false;
  let groupBy = 'type';
  let viewMode = 'text';
  let editorDrag;
  let disposeAddSearch;
  const deckDemo = createDeckDemo(container);
  let staleDeckId = null;
  let deferredLibraryRefresh = false;
  const identitySearchPreferences = new Map();
  const fiveDhDecks = new Set();
  const searchDrafts = new Map();
  const pendingCandidateAdds = new Set();
  const collapsedLanes = new Map();
  const openFold = new WeakMap();
  let foldId = 0;
  const openModals = new Set();
  const coverRequests = new Map();
  function closeCardMenus(except = null, restoreFocus = false) {
    let closed = false;
    for (const menu of container.querySelectorAll('.deck-entry-actions[open]')) {
      if (menu === except) continue;
      menu.open = false;
      if (restoreFocus) menu.querySelector('summary')?.focus({ preventScroll: true });
      closed = true;
    }
    return closed;
  }
  function dismissCardMenus(event) {
    const menu = event.target.closest?.('.deck-entry-actions');
    closeCardMenus(menu && container.contains(menu) ? menu : null);
  }
  function escapeCardMenu(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (closeCardMenus(null, true)) { event.preventDefault(); event.stopPropagation(); }
  }
  document.addEventListener('pointerdown', dismissCardMenus, true);
  document.addEventListener('keydown', escapeCardMenu, true);
  const store = new DeckStore({ key: syncDeckLibrary ? deviceDeckStorageKey() : undefined, onChange: updateStatus });
  const syncController = syncDeckLibrary ? createDeckSync(store, {
    onStatusChange: updateStatus,
    onLibraryChange: onSyncedLibrary,
    canPull: () => !selectedId && !openingId && !openModals.size,
  }) : null;

  function displayStatus() {
    const cloud = syncController?.status;
    return store.status.state === 'error' || !cloud || cloud.state === 'local' ? store.status : cloud;
  }
  function updateStatus() {
    const current = displayStatus();
    for (const node of container.querySelectorAll('.deck-save-status')) {
      if (node.textContent !== current.message) node.textContent = current.message;
      node.classList.toggle('has-error', current.state === 'error');
    }
    for (const retry of container.querySelectorAll('.deck-sync-retry')) retry.hidden = syncController?.status.state !== 'error';
    for (const refresh of container.querySelectorAll('.deck-sync-refresh')) refresh.hidden = !staleDeckId;
  }
  function onSyncedLibrary(previous, current) {
    const deckId = openingId || selectedId;
    if (deckId) {
      const before = previous.decks.find(deck => deck.id === deckId);
      const after = current.decks.find(deck => deck.id === deckId);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        staleDeckId = deckId;
        editorDrag?.cancel();
      }
    } else if (openModals.size) deferredLibraryRefresh = true;
    else render();
    updateStatus();
    onLibraryChange();
  }
  function reopenSyncedDeck() {
    const id = staleDeckId;
    if (id && store.get(id)) void openDeck(id);
    else showLibrary();
  }
  function notifyError(error, target) { if (target) { target.textContent = error.message; target.hidden = false; } store.status = { state: 'error', message: `操作未完成：${error.message}` }; updateStatus(); onNotify(error.message, 'error'); }
  function run(action, { success, refresh = true, errorTarget } = {}) {
    if (syncController && !syncController.canEdit) {
      const message = '请先完成账号同步，再编辑卡组';
      if (errorTarget) { errorTarget.textContent = message; errorTarget.hidden = false; }
      onNotify(message, 'error');
      return null;
    }
    if (staleDeckId) {
      const message = '这套卡组已有云端更新，请重新打开卡组';
      if (errorTarget) { errorTarget.textContent = message; errorTarget.hidden = false; }
      onNotify(message, 'error');
      return null;
    }
    try { const result = action(); if (refresh) render(); onLibraryChange(); if (success) onNotify(success, 'success'); return result; }
    catch (error) { notifyError(error, errorTarget); return null; }
  }
  function setCards(nextCards) {
    for (const card of nextCards) {
      const previous = index.get(card.id), versions = new Map((previous?.versions || []).map(version => [version.id, version]));
      for (const version of card.versions || []) versions.set(version.id, version);
      index.set(card.id, { ...previous, ...card, ...(card.faces ? { faces: card.faces.map((face, position) => ({ ...previous?.faces?.[position], ...face })) } : {}), versions: [...versions.values()], versionsComplete: Boolean(previous?.versionsComplete || card.versionsComplete) });
    }
    cards = [...index.values()];
  }
  async function ensureCards(deck) {
    if (loadDeckCards && deck) {
      const loaded = await loadDeckCards(deck);
      if (!Array.isArray(loaded)) throw new Error('卡牌数据尚未载入，请重试');
      setCards(loaded); return cards;
    }
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
    openingId = id; openingError = null; analysisOpen = false; staleDeckId = null; render();
    try {
      await ensureCards(store.get(id));
      if (request !== openRequest) return false;
      if (staleDeckId === id) return false;
      if (!store.get(id)) throw new Error('卡组已不存在，请返回卡组库重新选择');
      openingId = null; selectedId = id; render(); return true;
    } catch (error) {
      if (request !== openRequest) return false;
      openingError = error; render(); onNotify(error.message, 'error'); return false;
    }
  }
  function dialog(title, options = {}) {
    const originalClose = options.onClose;
    const current = modal(title, { ...options, onClose: () => {
      openModals.delete(current);
      originalClose?.();
      if (deferredLibraryRefresh) queueMicrotask(() => {
        if (deferredLibraryRefresh && !selectedId && !openingId && !openModals.size) render();
      });
    } });
    openModals.add(current);
    return current;
  }
  function status() {
    const current = displayStatus();
    const node = el('p', `deck-save-status${current.state === 'error' ? ' has-error' : ''}`, current.message);
    node.setAttribute('role', 'status');
    if (!syncController) return node;
    const line = el('div', 'deck-sync-status');
    const retry = button('重试同步', () => { void syncController.sync(); }, 'button button-quiet deck-sync-retry');
    retry.hidden = syncController.status.state !== 'error';
    const refresh = button('重新打开卡组', reopenSyncedDeck, 'button button-quiet deck-sync-refresh');
    refresh.hidden = !staleDeckId;
    line.append(node, retry, refresh);
    return line;
  }
  async function shareDialog(deck) {
    const current = dialog('分享卡组');
    current.panel.classList.add('deck-share-dialog');
    const info = el('p', 'deck-muted', '开启后，持有链接的人可查看主牌、统帅和卡组说明。候选牌及单卡备注不公开。');
    const state = el('p', 'deck-muted', '正在读取分享状态…'); state.setAttribute('role', 'status');
    const link = input(''); link.readOnly = true; link.hidden = true; link.setAttribute('aria-label', '卡组分享链接');
    link.addEventListener('focus', () => link.select());
    const error = el('p', 'deck-form-error'); error.hidden = true;
    const actions = el('div', 'deck-actions');
    let owner = null, shareURL = null, busy = false;
    const request = async (method = 'GET') => {
      const response = await fetch('/api/deck-shares/' + encodeURIComponent(deck.id), {
        method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: owner ? { 'X-Tieyou-Share-Owner': encodeURIComponent(owner) } : {},
      });
      const result = await response.json();
      if (!response.ok) { const failure = new Error(result.error?.message || '分享暂时无法使用'); failure.status = response.status; throw failure; }
      return result;
    };
    const copyLink = async () => {
      try { await navigator.clipboard.writeText(shareURL); onNotify('分享链接已复制', 'success'); }
      catch { link.focus(); link.select(); onNotify('请复制分享链接'); }
    };
    const refresh = () => {
      link.hidden = !shareURL; link.value = shareURL || '';
      state.textContent = shareURL ? '分享已开启，牌表同步后链接会随之更新。' : '分享未开启';
      enable.textContent = shareURL ? '复制链接' : '开启分享并复制链接';
      enable.disabled = busy || !owner; stop.hidden = !shareURL; stop.disabled = busy;
    };
    const enable = button('开启分享并复制链接', async () => {
      if (busy) return; busy = true; error.hidden = true; refresh();
      try { if (!shareURL) shareURL = (await request('POST')).url; if (current.panel.isConnected) { refresh(); await copyLink(); } }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { busy = false; refresh(); }
    }, 'button button-primary'); enable.disabled = true;
    const stop = button('关闭分享', async () => {
      if (busy) return; busy = true; error.hidden = true; refresh();
      try { await request('DELETE'); shareURL = null; onNotify('分享已关闭，原链接已失效'); }
      catch (failure) { error.textContent = failure.message; error.hidden = false; }
      finally { busy = false; refresh(); }
    }, 'button deck-danger'); stop.hidden = true;
    actions.append(enable, stop); current.panel.append(info, state, link, error, actions);
    try {
      if (staleDeckId) throw new Error('请先重新打开卡组，再进行分享');
      await syncController?.sync(false);
      if (syncController?.status.state === 'error') throw new Error(syncController.status.message);
      const result = await request(); owner = result.username; shareURL = result.url;
      if (current.panel.isConnected) refresh();
    } catch (failure) {
      state.textContent = ''; error.textContent = failure.message; error.hidden = false;
      if (failure.status === 401) actions.append(button('登录', () => { current.close(); document.querySelector('.account-open')?.click(); }));
    }
  }

  function createDialog() {
    const current = dialog('新建卡组'); const name = input(''); name.placeholder = '卡组名称'; name.maxLength = 200;
    const error = el('p', 'deck-form-error'); error.hidden = true;
    const form = el('form', 'deck-stack'); form.append(field('卡组名称', name), error);
    const submit = button('创建卡组', () => {}, 'button button-primary'); submit.type = 'submit';
    form.append(submit); form.addEventListener('submit', event => {
      event.preventDefault(); const deck = run(() => store.importEntries(name.value.trim() || '未命名卡组', []), { refresh: false, errorTarget: error });
      if (deck) { current.close(); void openDeck(deck.id); }
    }); current.panel.append(form); queueMicrotask(() => name.focus());
  }
  function paintCover(banner, label, commander) {
    const card = index.get(commander?.cardId);
    label.textContent = card?.zhName || card?.name || (commander ? '已设置统帅' : '尚未设置统帅');
    const version = getVersion(card, commander?.versionId);
    const image = version?.faceImages?.[0] || version?.image || card?.faces?.[0]?.image || card?.image;
    if (!image || !/^https?:\/\//i.test(image)) return;
    const img = el('img');
    img.loading = 'lazy';
    img.alt = '';
    img.addEventListener('error', () => {
      const fallback = card?.faces?.[0]?.image || card?.image;
      if (fallback && /^https?:\/\//i.test(fallback) && img.getAttribute('src') !== fallback) img.src = fallback;
      else banner.replaceChildren(el('span', '', '♧'));
    });
    img.src = image;
    banner.replaceChildren(img);
  }

  function loadLibraryCovers(covers) {
    if (!loadCardsByIds) return;
    const missing = new Map();
    for (const { commander } of covers) {
      const key = JSON.stringify([commander.cardId, commander.versionId]);
      if (!coverRequests.has(key)) missing.set(key, commander);
    }
    if (missing.size) {
      const versions = [...missing.values()].map(({ cardId, versionId }) => ({ cardId, versionId }));
      const request = Promise.resolve()
        .then(() => loadCardsByIds(versions.map(version => version.cardId), { versions, allowMissing: true }))
        .then(setCards)
        .catch(() => { /* A cover lookup must not prevent opening the library. */ })
        .finally(() => { for (const key of missing.keys()) coverRequests.delete(key); });
      for (const key of missing.keys()) coverRequests.set(key, request);
    }
    for (const { banner, label, commander } of covers) {
      const key = JSON.stringify([commander.cardId, commander.versionId]);
      void coverRequests.get(key).then(() => {
        if (banner.isConnected) paintCover(banner, label, commander);
      });
    }
  }

  function renderLibrary() {
    const decks = store.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const header = el('div', 'deck-page-heading'); const title = el('div'); title.append(el('h1', '', '卡组库'));
    header.append(title);
    if (decks.length || store.loadBlocked) {
      const actions = el('div', 'deck-actions');
      actions.append(button('导入牌表', importDialog), button('备份全部', () => exportDialog()), button('＋ 新建卡组', createDialog, 'button button-primary'));
      header.append(actions);
    }
    container.append(header, status());
    if (store.loadBlocked) {
      const recovery = el('div', 'deck-recovery'); recovery.append(el('strong', '', '本地数据读取失败，写入已暂停'), el('p', 'deck-muted', '原始内容仍保留在浏览器中。请先下载原始数据，再决定是否重建空白卡组库。'));
      if (store.recoveryRaw !== null) recovery.append(button('下载原始数据', () => download(store.recoveryRaw, 'edh-library-recovery.txt')), button('保留副本并重建', () => {
        const current = dialog('重建本地卡组库');
        current.panel.append(el('p', 'deck-muted', '将先在浏览器保留原始数据恢复副本，再建立空白卡组库。原始文件也可先下载到设备，供后续检查和修复。'), button('下载原始数据', () => download(store.recoveryRaw, 'edh-library-recovery.txt')), button('确认保留副本并重建', () => { const result = run(() => store.rebuildAfterCorruption(), { refresh: false }); if (result) { current.close(); render(); onNotify('已保留恢复副本并重建本地库', 'success'); } }, 'button deck-danger'));
      }));
      container.append(recovery);
    }
    if (!decks.length && !store.loadBlocked) {
      const empty = el('div', 'deck-empty deck-empty-guide');
      empty.append(el('h2', '', '暂无卡组'));
      const paths = el('div', 'deck-guide-paths');
      for (const [label, hint, action, style] of [
        ['新建卡组', '从这里组第一套！', createDialog, 'new'],
        ['导入牌表', '已有牌表？放这里！', importDialog, 'import'],
      ]) {
        const path = el('div', 'deck-guide-path deck-guide-path-' + style);
        const note = el('p', 'deck-guide-note', hint);
        path.append(note, drawGuideMark('arrow'), button(label, action, style === 'new' ? 'button button-primary' : 'button'));
        paths.append(path);
      }
      empty.append(paths);
      container.append(empty);
    } else if (decks.length) {
      const grid = el('div', 'deck-library-grid');
      const covers = [];
      for (const deck of decks) {
        const count = deck.entries.filter(entry => entry.zone !== 'considering').reduce((sum, entry) => sum + entry.quantity, 0);
        const consideringCount = deck.entries.filter(entry => entry.zone === 'considering').reduce((sum, entry) => sum + entry.quantity, 0);
        const tile = el('article', 'deck-tile');
        const commander = deck.entries.find(entry => entry.zone === 'commander');
        const banner = el('div', 'deck-tile-art');
        banner.append(el('span', '', '♧'));
        const open = button(deck.name, () => { void openDeck(deck.id); }, 'deck-title-button');
        const label = el('p', 'deck-muted deck-clamp');
        paintCover(banner, label, commander);
        if (commander && !getVersion(index.get(commander.cardId), commander.versionId)) covers.push({ banner, label, commander });
        const body = el('div', 'deck-tile-body'); body.append(open, label, el('p', 'deck-tile-count', `${count} / 100 张 · ${consideringCount} 张候选`));
        if (deck.description) body.append(el('p', 'deck-muted deck-clamp', deck.description));
        const footer = el('div', 'deck-tile-footer'); footer.append(el('span', 'deck-muted', new Date(deck.updatedAt).toLocaleDateString('zh-CN')), button('编辑 →', () => { void openDeck(deck.id); }));
        body.append(footer); tile.append(banner, body); grid.append(tile);
      }
      container.append(grid);
      loadLibraryCovers(covers);
    }
    const deleted = store.deleted();
    if (deleted.length) {
      const section = el('details', 'deck-trash'); section.append(el('summary', '', `最近删除 · ${deleted.length} 套`));
      for (const item of deleted.slice().reverse()) { const row = el('div', 'deck-trash-row'); row.append(el('span', '', item.deck.name), button('恢复', () => run(() => store.restore(item.deck.id), { success: '卡组已恢复' }))); section.append(row); }
      container.append(section);
    }
  }
  function saveEntry(entryId, changes, errorTarget) {
    return run(() => {
      const deck = store.get(selectedId);
      const entry = deck?.entries.find(item => item.id === entryId);
      if (!entry) throw new Error('这张牌已移出卡组');
      Object.assign(entry, changes);
      return store.save(deck);
    }, { errorTarget });
  }

  function changeEntryVersion(context, card, version) {
    return run(() => {
      const deck = store.get(context.deckId);
      const entry = deck?.entries.find(item => item.id === context.entryId && item.cardId === card.id);
      if (!entry) throw new Error('这张牌已移出卡组');
      if (!card.versions?.some(item => item.id === version.id)) throw new Error('印刷版本不存在，请重新打开详情');
      index.set(card.id, card);
      entry.versionId = version.id;
      return store.save(deck);
    });
  }

  function moveEntry(entryId, destination, fromDrag = false) {
    const deck = store.get(selectedId);
    const entry = deck?.entries.find(item => item.id === entryId);
    if (!entry) return;
    if (Object.hasOwn(destination, 'category')) {
      if (entry.zone === 'commander') return;
      const names = getDeckCategories(deck);
      const next = destination.category;
      if (next === getDeckEntryCategory(entry) || (next !== null && !names.includes(next))) return;
      deck.customCategories = names;
      entry.categories = next === null ? [] : [next];
    } else if (Object.hasOwn(editorZones, destination.zone) && entry.zone !== destination.zone) {
      entry.zone = destination.zone;
    } else return;
    const saved = run(() => store.save(deck), { refresh: false });
    if (saved) render(fromDrag);
  }

  function editCategory(deckId, previous = null, remove = false) {
    const current = dialog(remove ? '删除分类' : previous === null ? '新建分类' : '分类改名');
    const form = el('form', 'deck-stack');
    const name = input(previous || ''); name.maxLength = 100;
    const error = el('p', 'deck-form-error'); error.hidden = true;
    const submit = button(remove ? '删除分类' : '保存分类', () => {}, remove ? 'button deck-danger' : 'button button-primary');
    submit.type = 'submit';
    if (remove) form.append(el('p', '', `「${previous}」中的牌将移到未分类。`));
    else form.append(field('分类名称', name));
    form.append(error, submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const saved = run(() => {
        const deck = store.get(deckId);
        if (!deck) throw new Error('卡组已不存在');
        const names = getDeckCategories(deck);
        if (previous !== null && !names.includes(previous)) throw new Error('分类已不存在');
        const next = remove ? null : name.value.trim();
        if (!remove && (!next || next === '未分类')) throw new Error('请输入其他分类名称');
        if (next !== previous && names.includes(next)) throw new Error('已有同名分类');
        deck.customCategories = previous === null ? [...names, next] : names.map(category => category === previous ? next : category).filter(Boolean);
        if (previous !== null && next !== previous) {
          for (const entry of deck.entries) {
            if (getDeckEntryCategory(entry) === previous) entry.categories = next === null ? [] : [next, ...entry.categories.slice(1)];
          }
        }
        return store.save(deck);
      }, { refresh: false, errorTarget: error });
      if (saved) { current.close(); render(); }
    });
    current.panel.append(form);
    if (!remove) queueMicrotask(() => name.focus());
  }

  function renderDeckMetadata(deck) {
    const title = el('div', 'deck-inline-metadata');
    const heading = el('h1', 'deck-inline-heading');
    const titleText = el('span', '', deck.name);
    const editName = button('', () => openEditor(nameForm, name, heading), 'deck-inline-pencil');
    editName.setAttribute('aria-label', `编辑卡组名称：${deck.name}`);
    editName.title = '编辑卡组名称';
    editName.append(titleText, drawGuideMark('pencil'));
    heading.append(editName);

    const name = input(deck.name);
    name.maxLength = 200;
    name.required = true;
    name.setAttribute('aria-label', '卡组名称');
    const description = el('textarea', 'deck-input');
    description.value = deck.description;
    description.rows = 3;
    description.maxLength = 10000;
    description.setAttribute('aria-label', '卡组说明');
    const descriptionTrigger = button(deck.description || '补充卡组信息',
      () => openEditor(descriptionForm, description, descriptionTrigger), 'deck-inline-description');
    descriptionTrigger.classList.toggle('is-placeholder', !deck.description);
    descriptionTrigger.setAttribute('aria-label', deck.description ? '编辑卡组说明' : '补充卡组信息');

    function openEditor(form, control, trigger) {
      trigger.hidden = true;
      form.hidden = false;
      control.focus();
      if (control === name) name.select();
    }

    function editor(control, key, trigger, focusTarget, onSaved) {
      const form = el('form', 'deck-inline-form deck-inline-' + key + '-form');
      const actions = el('div', 'deck-inline-form-actions');
      const save = el('button', 'button button-primary', '保存');
      save.type = 'submit';
      const error = el('p', 'deck-form-error');
      error.hidden = true;
      error.setAttribute('role', 'alert');
      function close() {
        form.hidden = true;
        error.hidden = true;
        trigger.hidden = false;
        focusTarget.focus();
      }
      actions.append(save, button('取消', () => { control.value = store.get(deck.id)?.[key] ?? ''; close(); }));
      form.append(control, actions, error);
      form.hidden = true;
      form.addEventListener('submit', event => {
        event.preventDefault();
        const value = key === 'name' ? control.value.trim() : control.value;
        const latest = store.get(deck.id);
        if (!latest) return;
        if (value !== latest[key] && !run(() => store.save({ ...latest, [key]: value }), { refresh: false, errorTarget: error })) return;
        control.value = value;
        onSaved(value);
        close();
      });
      form.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          control.value = store.get(deck.id)?.[key] ?? '';
          close();
        }
      });
      return form;
    }

    const nameForm = editor(name, 'name', heading, editName, value => {
      titleText.textContent = value;
      editName.setAttribute('aria-label', `编辑卡组名称：${value}`);
    });
    const descriptionForm = editor(description, 'description', descriptionTrigger, descriptionTrigger, value => {
      descriptionTrigger.textContent = value || '补充卡组信息';
      descriptionTrigger.classList.toggle('is-placeholder', !value);
      descriptionTrigger.setAttribute('aria-label', value ? '编辑卡组说明' : '补充卡组信息');
    });
    title.append(heading, nameForm, descriptionTrigger, descriptionForm);
    return title;
  }

  function saveEditorPreferences(changes, focusSelector) {
    const saved = run(() => {
      const deck = store.get(selectedId);
      if (!deck) throw new Error('卡组已不存在');
      deck.editorPreferences = { ...getDeckEditorPreferences(deck), ...changes };
      return store.save(deck);
    });
    if (saved) container.querySelector?.(focusSelector)?.focus({ preventScroll: true });
    return saved;
  }

  function renderEditor(deck, expandAfterDrop) {
    const preferences = getDeckEditorPreferences(deck);
    groupBy = preferences.groupBy;
    viewMode = preferences.viewMode;
    const back = button('← 卡组库', showLibrary); back.classList.add('deck-workshop-back'); back.setAttribute('aria-label', '返回卡组库'); container.append(back);
    const header = el('div', 'deck-page-heading deck-workshop-heading'); const title = renderDeckMetadata(deck);
    const actions = el('div', 'deck-actions');
    const analyze = button('卡组分析', () => {
      analysisOpen = true;
      render();
      container.querySelector('.deck-analysis-heading')?.querySelector('button')?.focus();
    });
    analyze.setAttribute('data-deck-analysis', '');
    actions.append(analyze, button('手动测试 ↗', () => { const fresh = store.get(deck.id); if (fresh) onPlaytest(fresh); else onNotify('卡组已不存在，请重新选择', 'error'); }, 'button button-primary'), button('复制', () => { const copy = run(() => store.copy(deck.id), { refresh: false }); if (copy) { selectedId = copy.id; render(); onNotify('已创建独立副本', 'success'); } }), button('导出', () => exportDialog(deck)), button('分享', () => shareDialog(deck)), button('删除', () => deleteDialog(deck), 'button deck-danger'));
    header.append(title, actions); container.append(header, status());
    const stats = validateDeck(deck, cards); const statsGrid = el('div', 'deck-stats');
    for (const [value, label] of [[`${stats.count} / 100`, '正式卡组'], [stats.commanderCount, '统帅'], [stats.consideringCount, '候选牌'], [stats.colorIdentity.join(' · ') || '—', '统帅标识色']]) { const box = el('div'); box.append(el('strong', '', value), el('span', '', label)); statsGrid.append(box); }
    container.append(statsGrid);
    const issues = stats.issues.filter(issue => !['commander-combination', 'commander-eligibility'].includes(issue.code));
    const entryIssues = new Map(), entryRows = new Map();
    if (issues.length) {
      const checks = el('details', `deck-checks${issues.some(issue => issue.severity === 'error') ? ' has-issues' : ''}`);
      checks.append(el('summary', '', `组牌检查 · ${issues.length} 项问题`));
      const list = el('ul');
      let highlighted = [], highlightTimer, jumpTimer;
      const clearHighlight = () => {
        for (const row of highlighted) row.classList.remove('is-highlighted');
        highlighted = [];
      };
      function jumpToEntries(entryIds) {
        const ids = new Set(entryIds);
        clearTimeout(highlightTimer);
        clearTimeout(jumpTimer);
        clearHighlight();
        highlighted = [...entryRows].filter(([id]) => ids.has(id)).map(([, row]) => row);
        const first = highlighted[0];
        if (!first) return;
        let unfolded = false;
        for (const row of highlighted) {
          for (let ancestor = row.parentNode; ancestor && ancestor !== container; ancestor = ancestor.parentNode) {
            if (ancestor.tagName?.toLowerCase() === 'details') ancestor.open = true;
            if (openFold.get(ancestor)?.()) unfolded = true;
          }
          row.classList.add('is-highlighted');
        }
        const jump = () => {
          first.focus({ preventScroll: true });
          first.scrollIntoView({ block: 'center' });
        };
        if (unfolded) jumpTimer = setTimeout(jump, 200);
        else jump();
        highlightTimer = setTimeout(clearHighlight, 1800);
      }
      for (const issue of issues) {
        const item = el('li', issue.severity === 'error' ? 'deck-check-error' : 'deck-check-warning');
        if (issue.entryIds.length) {
          for (const id of issue.entryIds) {
            if (!entryIssues.has(id)) entryIssues.set(id, []);
            entryIssues.get(id).push(issue);
          }
          item.append(button(issue.message, () => jumpToEntries(issue.entryIds), 'deck-check-jump'));
        } else item.textContent = issue.message;
        list.append(item);
      }
      checks.append(list); container.append(checks);
    }
    const budgetOption = el('label', 'deck-check-label deck-five-dh-toggle');
    const budgetToggle = input('', 'checkbox');
    budgetToggle.checked = fiveDhDecks.has(deck.id);
    budgetToggle.addEventListener('change', () => {
      if (budgetToggle.checked) fiveDhDecks.add(deck.id);
      else fiveDhDecks.delete(deck.id);
      render();
      container.querySelector('.deck-five-dh-toggle input')?.focus({ preventScroll: true });
    });
    budgetOption.append(budgetToggle, el('span', '', '5DH 检查'));
    const search = renderAddSearch(deck);
    const target = renderDeckBoard(deck, entryIssues, entryRows, expandAfterDrop, budgetOption);
    search.refresh();
    deckDemo?.attach({
      deck, target, ...search,
      drop: (candidate, signal) => editorDrag.dropHandle(candidate.handle, target, { signal }),
    });
  }

  function renderDeckBoard(deck, entryIssues, entryRows, expandAfterDrop, budgetOption) {
    const preferences = getDeckEditorPreferences(deck);
    const compareEntries = createDeckEntryComparator(deck, index, preferences);
    const byCategory = groupBy === 'category';
    const categoryNames = getDeckCategories(deck);
    const listHeader = el('div', 'deck-list-heading deck-editor-toolbar');
    const controls = el('div', 'deck-editor-controls');
    const views = el('div', 'deck-editor-views'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', '牌表视图');
    for (const [mode, label] of deckViews) {
      const option = button(label, () => {
        if (viewMode === mode) return;
        saveEditorPreferences({ viewMode: mode }, `[data-deck-view-mode="${mode}"]`);
      }, 'deck-editor-view-button');
      option.setAttribute('aria-pressed', String(viewMode === mode));
      option.setAttribute('data-deck-view-mode', mode);
      views.append(option);
    }
    const grouping = select([['type', '按卡牌类型'], ['mana', '按法术力值'], ['color', '按卡牌颜色'], ['category', '按个人分类']], groupBy);
    grouping.setAttribute('aria-label', '牌表整理方式');
    grouping.addEventListener('change', () => {
      if (!saveEditorPreferences({ groupBy: grouping.value }, '[aria-label="牌表整理方式"]')) grouping.value = groupBy;
    });
    const sorting = select(DECK_SORT_OPTIONS, preferences.sortBy);
    sorting.setAttribute('aria-label', '牌表排序方式');
    sorting.classList.add('deck-editor-sort-select');
    sorting.addEventListener('change', () => {
      if (!saveEditorPreferences({ sortBy: sorting.value, sortDirection: defaultSortDirection(sorting.value) }, '[aria-label="牌表排序方式"]')) {
        sorting.value = preferences.sortBy;
      }
    });
    const nextDirection = preferences.sortDirection === 'asc' ? 'desc' : 'asc';
    const direction = button(preferences.sortDirection === 'asc' ? '↑' : '↓', () => {
      saveEditorPreferences({ sortDirection: nextDirection }, '[data-sort-direction]');
    }, 'button deck-editor-sort-direction');
    const label = sortDirectionLabel(preferences.sortBy, preferences.sortDirection);
    direction.title = label;
    direction.setAttribute('aria-label', `${label}，切换为${sortDirectionLabel(preferences.sortBy, nextDirection)}`);
    direction.setAttribute('data-sort-direction', preferences.sortDirection);
    const sortControls = el('div', 'deck-editor-sort-controls');
    sortControls.append(sorting, direction);
    controls.append(views, grouping, sortControls);
    if (byCategory) controls.append(button('＋ 新建分类', () => editCategory(deck.id)));
    const heading = el('div', 'deck-list-title');
    heading.append(el('h2', '', '卡组牌表'), budgetOption);
    listHeader.append(heading, controls);
    container.append(listHeader);

    const board = el('div', `deck-editor-board deck-editor-view-${viewMode}${byCategory ? ' is-category' : ''}`);
    let mainHeading;
    if (!collapsedLanes.has(deck.id)) collapsedLanes.set(deck.id, new Set());
    const collapsed = collapsedLanes.get(deck.id);
    const folds = [];
    let dragFolding = expandAfterDrop;
    function setDragFolding(active) {
      dragFolding = active;
      for (const update of folds) update();
    }
    editorDrag = createDeckEditorDrag(board, {
      inputRoot: container,
      onMove: (entryId, destination) => moveEntry(entryId, destination, true),
      onAdd: (source, destination, options) => addCandidate(deck.id, source, destination, true, options),
      onDragChange: setDragFolding,
    });
    const count = entries => entries.reduce((sum, entry) => sum + entry.quantity, 0);

    function createFold(heading, label, key, entries) {
      const title = `${label} · ${count(entries)}`;
      const fold = el('div', 'deck-editor-fold');
      const inner = el('div', 'deck-editor-fold-inner');
      fold.append(inner);
      if (!entries.length) {
        heading.append(el('span', 'deck-editor-empty-title', title));
        return { fold, inner };
      }
      fold.id = `deck-editor-fold-${++foldId}`;
      let folded, clipTimer;
      const toggle = button(title, () => {
        if (dragFolding) return;
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        update();
      }, 'deck-editor-fold-toggle');
      toggle.setAttribute('aria-controls', fold.id);
      function update() {
        const next = collapsed.has(key) || dragFolding;
        if (next === folded) return;
        if (folded !== undefined) {
          clearTimeout(clipTimer);
          fold.classList.add('is-folding');
          clipTimer = setTimeout(() => fold.classList.remove('is-folding'), 200);
        }
        folded = next;
        fold.classList.toggle('is-folded', next);
        fold.inert = next;
        toggle.setAttribute('aria-expanded', String(!next));
      }
      fold.addEventListener('transitionend', event => {
        if (event.target !== fold || event.propertyName !== 'grid-template-rows') return;
        clearTimeout(clipTimer);
        fold.classList.remove('is-folding');
      });
      openFold.set(fold, () => {
        if (!collapsed.delete(key)) return false;
        update();
        return true;
      });
      heading.append(toggle);
      folds.push(update);
      update();
      return { fold, inner };
    }

    function buildRows(entries, canDrag = true) {
      const rows = el('div', 'deck-editor-group-entries');
      const ordered = [...entries].sort(compareEntries);
      for (const entry of ordered) {
        const row = entryRow(entry, entryIssues.get(entry.id), categoryNames, canDrag);
        if (entryIssues.has(entry.id)) entryRows.set(entry.id, row);
        rows.append(row);
      }
      return rows;
    }

    function appendGroups(section, entries, zone = 'category') {
      for (const group of groupDeckEntries(entries, index, groupBy, categoryNames)) {
        const emptyUnclassified = byCategory && group.key === null && !group.entries.length;
        const lane = el('section', emptyUnclassified ? 'deck-editor-group is-empty-unclassified' : 'deck-editor-group');
        const heading = el('div', 'deck-editor-group-title');
        const title = el('h3');
        const key = byCategory ? `category:${JSON.stringify(group.key)}` : `group:${zone}:${groupBy}:${JSON.stringify(group.key)}`;
        const { fold, inner } = createFold(title, group.label, key, group.entries);
        heading.append(title);
        if (byCategory && group.key !== null) {
          const actions = el('div', 'deck-editor-category-actions');
          const rename = button('改名', () => editCategory(deck.id, group.key));
          const remove = button('删除', () => editCategory(deck.id, group.key, true));
          rename.setAttribute('aria-label', `改名分类 ${group.label}`);
          remove.setAttribute('aria-label', `删除分类 ${group.label}`);
          actions.append(rename, remove); heading.append(actions);
        }
        if (byCategory) editorDrag.registerTarget(heading, { category: group.key });
        inner.append(buildRows(group.entries));
        lane.append(heading, fold); section.append(lane);
      }
    }

    function appendZone(zone, label) {
      const entries = deck.entries.filter(entry => entry.zone === zone);
      const section = el('section', `deck-editor-zone${entries.length ? '' : ' is-empty'}`);
      const heading = el('h3', 'deck-zone-title deck-editor-zone-heading');
      if (zone === 'main') mainHeading = heading;
      const { fold, inner } = createFold(heading, label, `zone:${zone}`, entries);
      if (!byCategory) editorDrag.registerTarget(heading, { zone });
      if (zone === 'commander') inner.append(buildRows(entries, !byCategory));
      else appendGroups(inner, entries, zone);
      section.append(heading, fold);
      board.append(section);
    }
    if (byCategory) {
      if (deck.entries.some(entry => entry.zone === 'commander')) appendZone('commander', editorZones.commander);
      const section = el('div', 'deck-editor-zone deck-editor-category-zone');
      appendGroups(section, deck.entries.filter(entry => entry.zone !== 'commander'));
      board.append(section);
    } else {
      for (const [zone, label] of Object.entries(editorZones)) appendZone(zone, label);
    }
    if (!deck.entries.length && !byCategory) board.append(el('p', 'deck-empty deck-empty-small', '暂无卡牌'));
    container.append(board);
    if (expandAfterDrop && typeof requestAnimationFrame === 'function') {
      board.getBoundingClientRect();
      requestAnimationFrame(() => { if (board.isConnected) setDragFolding(false); });
    } else if (expandAfterDrop) setDragFolding(false);
    return mainHeading;
  }

  function entryRow(entry, issues = [], categoryNames, canDrag) {
    const card = index.get(entry.cardId); const wrapper = el('article', 'deck-entry'); const row = el('div', 'deck-entry-main');
    const name = card?.zhName || card?.name || `缺失卡牌 ${entry.cardId}`;
    const version = card ? getVersion(card, entry.versionId) : null;
    const inspect = () => card && onInspect(card, version, { deckId: selectedId, entryId: entry.id });
    wrapper.setAttribute('data-entry-id', entry.id);
    applyDeckCardColor(wrapper, card);
    const priceBadge = fiveDhDecks.has(selectedId)
      ? createDeckPriceBadge(card, { showPrice: viewMode === 'text' }) : null;
    const title = el('div', 'deck-entry-card');
    const inspectButton = button(name, inspect, 'deck-card-link deck-entry-name');
    inspectButton.title = name;
    title.append(inspectButton);
    if (card?.name && card.name !== name) {
      const english = el('span', 'deck-entry-english', card.name); english.title = card.name; title.append(english);
    }
    if (priceBadge && viewMode === 'text') title.append(priceBadge);
    let badges;
    if (issues.length) {
      wrapper.tabIndex = -1;
      badges = el('div', 'deck-entry-issues');
      for (const issue of issues) {
        const badge = el('span', 'deck-entry-issue', entryIssueLabels[issue.code] || issue.message);
        badge.title = issue.message;
        badges.append(badge);
      }
      if (viewMode === 'text') title.append(badges);
    }
    const quantity = quantityInput(entry.quantity); quantity.classList.add('deck-entry-quantity');
    quantity.addEventListener('change', () => saveEntry(entry.id, { quantity: Number(quantity.value) }));
    const zone = select(Object.entries(editorZones), entry.zone); zone.setAttribute('aria-label', '牌张分区');
    zone.addEventListener('change', () => moveEntry(entry.id, { zone: zone.value }));
    const versions = card?.versions?.length ? card.versions.map(version => [version.id, printingName(version)]) : [[entry.versionId, '默认版本']];
    if (!versions.some(([id]) => id === entry.versionId)) versions.unshift([entry.versionId, '当前版本缺失']);
    if (loadCardDetails && card && !card.versionsComplete) versions.push(['__load_versions__', '加载其他版本…']);
    const printing = select(versions, entry.versionId); printing.setAttribute('aria-label', '印刷版本');
    let loadingVersions = false;
    const completeVersions = async () => {
      if (!loadCardDetails || !card || loadingVersions) return;
      loadingVersions = true;
      try {
        const known = index.get(card.id);
        const full = known?.versionsComplete ? known : await loadCardDetails(card.id); setCards([{ ...full, versionsComplete: true }]);
        if (!printing.isConnected) return;
        const selected = printing.value === '__load_versions__' ? entry.versionId : printing.value;
        printing.replaceChildren();
        for (const version of index.get(card.id).versions || []) { const option = el('option', '', printingName(version)); option.value = version.id; printing.append(option); }
        printing.value = selected;
      } catch (error) { onNotify(error.message, 'error'); printing.value = entry.versionId; }
      finally { loadingVersions = false; }
    };
    printing.addEventListener('focus', completeVersions);
    printing.addEventListener('change', () => { if (printing.value === '__load_versions__') { printing.value = entry.versionId; void completeVersions(); } else saveEntry(entry.id, { versionId: printing.value }); });
    const remove = button('移除', () => run(() => { const deck = store.get(selectedId); deck.entries = deck.entries.filter(item => item.id !== entry.id); return store.save(deck); }), 'button deck-danger');
    remove.setAttribute('aria-label', `移除 ${name}`);
    const actions = el('details', 'deck-entry-actions');
    actions.setAttribute('name', 'tieyou-deck-card-actions');
    actions.addEventListener('toggle', () => { if (actions.open) closeCardMenus(actions); });
    const trigger = el('summary', 'deck-entry-menu-trigger', '…');
    trigger.setAttribute('aria-label', `操作 ${name}`); trigger.title = '卡牌操作';
    trigger.addEventListener('click', () => closeCardMenus(actions));
    const menu = el('div', 'deck-entry-menu');
    const close = button('×', () => {
      actions.open = false;
      trigger.focus({ preventScroll: true });
    }, 'button button-quiet deck-entry-menu-close');
    close.setAttribute('aria-label', '关闭卡牌操作');
    menu.append(close);
    if (viewMode !== 'text') menu.append(field('数量', quantity));
    menu.append(field('分区', zone), field('印刷版本', printing));
    if (groupBy === 'category' && entry.zone !== 'commander') {
      const categories = select([['', '未分类'], ...categoryNames.map(label => [label, label])], getDeckEntryCategory(entry) || '');
      categories.setAttribute('aria-label', '移动到分类');
      categories.addEventListener('change', () => moveEntry(entry.id, { category: categories.value || null }));
      menu.append(field('个人分类', categories));
    }
    menu.append(remove); actions.append(trigger, menu);

    if (viewMode === 'text') {
      if (canDrag) {
        const handle = button('⋮', () => {}, 'deck-drag-handle'); handle.tabIndex = -1;
        handle.title = '拖动卡牌'; handle.setAttribute('aria-label', `拖动 ${name}`);
        editorDrag.registerHandle(handle, entry.id, { preview: dragPreview(card, version, name) });
        row.append(handle);
      }
      const mana = el('div', 'deck-entry-mana');
      if (card?.manaCost) mana.append(renderManaCost(card.manaCost));
      row.append(quantity, title, mana, actions);
    } else {
      const image = createDeckCardImage({ card, version, name, onInspect: inspect, stackPreview: viewMode === 'stack' });
      if (canDrag && card) editorDrag.registerHandle(image, entry.id, { touchHold: true, preview: dragPreview(card, version, name) });
      wrapper.append(image);
      if (entry.quantity > 1) {
        const badge = el('span', 'deck-entry-quantity-badge', `×${entry.quantity}`);
        wrapper.append(badge);
      }
      if (priceBadge) wrapper.append(priceBadge);
      if (badges) row.append(badges);
      row.append(actions);
    }
    wrapper.append(row);
    return wrapper;
  }
  function renderAddSearch(deck) {
    const section = el('section', 'deck-add-section');
    const heading = el('h2', '', '添加卡牌');
    section.append(heading);
    const draft = searchDrafts.get(deck.id) || { query: '' }; searchDrafts.set(deck.id, draft);
    const form = el('form', 'deck-add-form'); const query = input(draft.query); query.placeholder = '牌名、系列＋编号或标签（如电震圈）'; query.setAttribute('aria-label', '搜索要加入的卡牌'); query.autocomplete = 'off';
    const advanced = button('高级搜索 ↗', () => {
      if (activeRequest) clearResults();
      cancelSuggestions();
      return onOpenCatalog({ deckId: deck.id, query: query.value.trim(), restrictIdentity: restrictIdentity.checked });
    });
    form.append(query, advanced); section.append(form);
    const commanderIdentity = getCommanderIdentity(deck, cards);
    const restrictIdentity = input('', 'checkbox'); restrictIdentity.checked = commanderIdentity !== null && identitySearchPreferences.get(deck.id) !== false; restrictIdentity.disabled = commanderIdentity === null;
    if (commanderIdentity !== null) {
      const colorNames = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿' };
      const identityLabel = el('label', 'deck-check-label'); identityLabel.append(restrictIdentity, el('span', '', `仅显示主将标识色内的牌（${commanderIdentity.map(color => colorNames[color]).join('、') || '无色'}）`));
      section.append(identityLabel);
    }
    const results = el('div', 'deck-add-results'); section.append(results);
    let candidateRequest = 0, suggestionTimer, scheduledKey, activeRequest, displayedKey;
    const candidateHandles = [];
    const candidatesForGuide = [];
    function clearResults(...children) {
      for (const remove of candidateHandles.splice(0)) remove();
      candidatesForGuide.length = 0;
      results.replaceChildren(...children);
    }
    const isCurrent = request => request === candidateRequest && query.isConnected && !container.hidden;
    function cancelSuggestions() {
      clearTimeout(suggestionTimer);
      scheduledKey = undefined;
      ++candidateRequest;
      activeRequest?.controller.abort();
      activeRequest = undefined;
    }
    function renderCandidates(result, request, normalizedQuery) {
      if (!isCurrent(request)) return;
      clearResults();
      const allCandidates = Array.isArray(result) ? result : result.cards;
      setCards(allCandidates);
      const candidates = allCandidates.slice(0, 8);
      if (!candidates.length) { results.append(el('p', 'deck-muted', restrictIdentity.checked ? '主将标识色范围内无匹配卡牌' : '无匹配卡牌')); return; }
      const total = result.total ?? allCandidates.length;
      if (total > 8) results.append(el('p', 'deck-muted', `显示前 8 项 · 共 ${total} 项匹配`));
      const printingQuery = !deckTagQuery(normalizedQuery) && normalizedQuery.match(/^([a-z0-9]+)\s*[:/#\s]\s*(\S+)$/);
      const quantities = new Map();
      for (const entry of deck.entries) quantities.set(entry.cardId, (quantities.get(entry.cardId) || 0) + entry.quantity);
      for (const card of candidates) {
        const row = el('div', 'deck-search-result');
        const label = card.zhName || card.name;
        const name = el('div');
        name.append(button(label, () => onInspect(card), 'deck-card-link'));
        if (card.name !== label) name.append(el('small', 'deck-muted', card.name));
        const version = printingQuery ? card.versions?.find(item => item.set.toLowerCase() === printingQuery[1] && String(item.collectorNumber).toLowerCase() === printingQuery[2]) : null;
        const amount = quantities.get(card.id) || 0;
        const source = { card, versionId: version?.id || defaultVersion(card) };
        let add;
        if (amount) add = el('span', 'deck-candidate-added', amount > 1 ? `已在卡组 ×${amount}` : '已在卡组');
        else {
          add = button('＋', async () => {
            add.disabled = true;
            try { await addCandidate(deck.id, source); }
            finally { if (add.isConnected) add.disabled = false; }
          }, 'button button-quiet deck-candidate-add');
          add.setAttribute('aria-label', `加入 ${label}`);
          name.classList.add('deck-candidate-drag');
          const remove = editorDrag.registerExternalHandle(name, source, {
            touchHold: true, preview: dragPreview(card, version || getVersion(card, source.versionId), label),
          });
          candidateHandles.push(remove);
        }
        row.append(name);
        if (fiveDhDecks.has(deck.id)) row.append(createDeckPriceBadge(card));
        row.append(add);
        results.append(row);
        candidatesForGuide.push({ card, row, handle: name, add });
      }
    }
    function showCandidates({ debounce = false, submitted = false } = {}) {
      const text = query.value.trim();
      const normalized = normalizeText(text);
      const colorIdentity = restrictIdentity.checked ? commanderIdentity : null;
      const key = JSON.stringify([normalized, colorIdentity]);
      if (key === activeRequest?.key) return activeRequest.promise;
      if (key === displayedKey || (debounce && key === scheduledKey)) return;
      cancelSuggestions();
      displayedKey = undefined;
      clearResults();
      const request = candidateRequest;
      if (!normalized || !isCurrent(request)) return;
      if (findCandidates && draft.completed?.key === key) {
        renderCandidates(draft.completed.result, request, normalized);
        displayedKey = key;
        return;
      }
      if (findCandidates && !submitted && /^[a-z0-9]$/.test(normalized)) return;
      const search = () => {
        scheduledKey = undefined;
        if (!isCurrent(request)) return;
        const options = { colorIdentity, limit: 8 };
        if (!findCandidates) {
          const tag = deckTagQuery(text);
          const result = tag
            ? searchCards(cards, [tag, commanderScopeQuery(colorIdentity)].filter(Boolean).join(' '), { commanderOnly: true }, 'edhrec')
            : findCardCandidates(text, cards, options);
          renderCandidates(result, request, normalized);
          return;
        }
        const controller = new AbortController();
        const active = { key, controller };
        activeRequest = active;
        const pending = el('p', 'deck-muted', '搜索中…');
        pending.setAttribute('role', 'status');
        results.append(pending);
        active.promise = Promise.resolve().then(() => {
          if (isCurrent(request)) return findCandidates(text, { ...options, signal: controller.signal });
        }).then(result => {
          if (!isCurrent(request)) return;
          renderCandidates(result, request, normalized);
          draft.completed = { key, result };
          displayedKey = key;
        }).catch(error => {
          if (!isCurrent(request) || error?.name === 'AbortError') return;
          clearResults(el('p', 'deck-form-error', error?.message || '搜索失败'), button('重试搜索', () => showCandidates({ submitted: true })));
        }).finally(() => {
          if (activeRequest === active) activeRequest = undefined;
        });
        return active.promise;
      };
      if (debounce) {
        scheduledKey = key;
        suggestionTimer = setTimeout(search, findCandidates ? 300 : 200);
      } else return search();
    }
    query.addEventListener('input', event => {
      draft.query = query.value;
      if (findCandidates && event.isComposing) {
        cancelSuggestions();
        displayedKey = undefined;
        clearResults();
        return;
      }
      showCandidates({ debounce: true });
    });
    query.addEventListener('compositionend', () => {
      if (!findCandidates) return;
      draft.query = query.value;
      showCandidates({ debounce: true });
    });
    query.addEventListener('change', () => {
      if (draft.query === query.value) return;
      draft.query = query.value;
      showCandidates();
    });
    form.addEventListener('submit', event => { event.preventDefault(); draft.query = query.value; showCandidates({ submitted: true }); });
    restrictIdentity.addEventListener('change', () => { identitySearchPreferences.set(deck.id, restrictIdentity.checked); showCandidates(); });
    const visibilityObserver = findCandidates && typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
      if (container.hidden) cancelSuggestions();
    }) : null;
    visibilityObserver?.observe(container, { attributes: true, attributeFilter: ['hidden'] });
    disposeAddSearch = () => { visibilityObserver?.disconnect(); cancelSuggestions(); clearResults(); };
    container.append(section);
    return {
      section, heading, query, results, candidates: candidatesForGuide,
      refresh: () => showCandidates({ debounce: Boolean(findCandidates) }),
      submit: value => {
        query.value = value;
        draft.query = value;
        return showCandidates({ submitted: true });
      },
    };
  }
  async function addCandidate(deckId, { card, versionId }, destination = {}, fromDrag = false, { signal } = {}) {
    const key = JSON.stringify([deckId, card.id]);
    if (pendingCandidateAdds.has(key)) return false;
    pendingCandidateAdds.add(key);
    try {
      if (loadCardsByIds) {
        const loaded = await loadCardsByIds([card.id], { versions: [{ cardId: card.id, versionId }], ...(signal && { signal }) });
        const ready = loaded.find(item => item.id === card.id);
        if (!ready) throw new Error('卡牌数据未找到，请重试');
        card = ready;
      }
      if (signal?.aborted) return false;
      return quickAddCard(card, versionId, deckId, { ...destination, skipExisting: true, fromDrag, quiet: Boolean(signal) });
    } catch (error) {
      if (!signal?.aborted) onNotify(error.message, 'error');
      return false;
    } finally { pendingCandidateAdds.delete(key); }
  }
  function quickAddCard(card, version, deckId = selectedId, { zone = 'main', category = null, skipExisting = false, fromDrag = false, quiet = false } = {}) {
    const deck = store.get(deckId);
    if (!deck) { onNotify('目标卡组已不存在，请重新选择卡组', 'error'); return false; }
    if (skipExisting && deck.entries.some(entry => entry.cardId === card.id)) return false;
    if (category !== null && !getDeckCategories(deck).includes(category)) {
      onNotify('目标分类已不存在', 'error');
      return false;
    }
    setCards([card]);
    const versionId = typeof version === 'string' ? version : version?.id || defaultVersion(card);
    const updated = run(() => store.addCard(deckId, card, versionId, zone, 1, category), { refresh: !fromDrag });
    if (!updated) return false;
    if (fromDrag) render(true);
    if (!quiet) onNotify(`已加入「${updated.name}」${category ? `的「${category}」` : `${editorZones[zone]}区`}`, 'success');
    return true;
  }
  async function addCard(card, version, preferredId = selectedId, { onAdded, chooseTarget = false, skipExisting = false } = {}) {
    if (!chooseTarget && loadCardDetails && !card.versionsComplete) {
      try { card = await loadCardDetails(card.id); setCards([card]); }
      catch (error) { onNotify(error.message, 'error'); return false; }
    }
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
      form.append(field('目标卡组', target), newNameField);
      if (!chooseTarget) form.append(field('加入分区', zone), field('数量', quantity), field('印刷版本', printing));
      form.append(error);
      const submit = button('加入卡组', () => {}, 'button button-primary'); submit.type = 'submit'; form.append(submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        const alreadyInDeck = skipExisting && store.get(target.value)?.entries.some(entry => entry.cardId === card.id);
        const updated = run(() => {
          const amount = Number(quantity.value);
          if (!Number.isInteger(amount) || amount < 1 || amount > 999) throw new Error('数量须为 1–999 的整数');
          if (target.value === '__new__') return store.importEntries(newName.value.trim() || '未命名卡组', [{ id: 'new', cardId: card.id, versionId: printing.value, quantity: amount, zone: zone.value, categories: [], notes: '' }]);
          if (alreadyInDeck) return store.get(target.value);
          return store.addCard(target.value, card, printing.value, zone.value, amount);
        }, { refresh: false, errorTarget: error });
        if (updated) {
          didAdd = !alreadyInDeck;
          selectedId = updated.id;
          onAdded?.(updated.id);
          current.close();
          render();
          onNotify(alreadyInDeck ? `已在「${updated.name}」` : `已加入「${updated.name}」`, 'success');
        }
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
    current.panel.append(el('p', 'deck-muted', `共 ${decks.length} 套卡组。JSON 保留版本、分区和自定义分类。文本保留数量、牌名、分区与版本。`), field('格式', format), output, error, actions);
  }
  async function importDialog() {
    const current = dialog('导入牌表与备份', { wide: true });
    if (!resolveDeckText && !loadCardsByIds) {
      const loading = el('p', 'deck-muted', '正在加载卡牌数据…'); current.panel.append(loading);
      try { await ensureCards(); }
      catch (error) {
        loading.textContent = `卡牌数据加载失败：${error.message}`;
        current.panel.append(button('重新加载', () => { current.close(); void importDialog(); }, 'button button-primary')); onNotify(error.message, 'error'); return;
      }
      loading.remove();
    }
    if (!openModals.has(current)) return;
    const format = select([['text', '文本牌表'], ['json', '完整 JSON 备份']], 'text');
    const name = input('导入的卡组'); name.maxLength = 200; const nameField = field('新卡组名称', name);
    const file = input('', 'file'); file.accept = '.json,.txt,.dec,.dek,text/plain,application/json';
    const source = el('textarea', 'deck-input deck-code'); source.rows = 10; source.placeholder = '[Commander]\n1 你的统帅牌名\n\n[Main]\n1 Sol Ring\n1 Command Tower (CMM) 396\n\n[Considering]\n1 Counterspell'; source.setAttribute('aria-label', '导入内容');
    const hint = el('p', 'deck-muted', '每行填写“数量 牌名”，支持中文、英文及可选的 (系列代码) 编号。仅创建新卡组，现有卡组会保留。');
    const error = el('p', 'deck-form-error'); error.hidden = true; const preview = el('div', 'deck-import-preview');
    let textRows = null, jsonPreview = null, previewRevision = 0, completedRows = null;
    const clearPreview = () => { ++previewRevision; textRows = null; jsonPreview = null; completedRows = null; preview.replaceChildren(); commitButton.disabled = true; previewButton.disabled = false; error.hidden = true; };
    source.addEventListener('input', clearPreview); format.addEventListener('change', () => { nameField.hidden = format.value === 'json'; clearPreview(); });
    file.addEventListener('change', async () => { const selected = file.files?.[0]; if (!selected) return; if (selected.size > 10_000_000) { notifyError(new Error('导入文件需小于 10 MB'), error); return; } try { source.value = await selected.text(); format.value = selected.name.toLowerCase().endsWith('.json') || source.value.trim().startsWith('{') ? 'json' : 'text'; nameField.hidden = format.value === 'json'; clearPreview(); } catch (err) { notifyError(err, error); } });
    function importRow(row) {
      const line = el('div', `deck-import-row${row.status !== 'ready' && !row.skipped ? ' has-error' : ''}`);
      const title = el('div', 'deck-import-row-heading'); title.append(el('strong', '', `第 ${row.line} 行 · ${zoneNames[row.zone]}`), el('span', '', row.skipped ? '已跳过' : row.message));
      const edit = input(row.raw); edit.setAttribute('aria-label', `修正第 ${row.line} 行`);
      const actions = el('div', 'deck-actions');
      actions.append(button('应用修正', async () => {
        const revision = previewRevision, correction = row.pendingCorrection = (row.pendingCorrection || 0) + 1;
        try {
          const text = `[${row.zone}]\n${edit.value}`;
          const result = resolveDeckText ? await resolveDeckText(text) : parseDeckText(text, cards);
          if (revision !== previewRevision || row.pendingCorrection !== correction || !openModals.has(current)) return;
          if (result.cards) setCards(result.cards);
          if (result.rows.length !== 1) throw new Error('每个修正项必须包含一行牌表内容');
          Object.assign(row, { ...result.rows[0], line: row.line, skipped: false }); refreshPreview();
        } catch (err) { if (revision === previewRevision && openModals.has(current)) notifyError(err, error); }
      }));
      if (row.status === 'version-missing') actions.append(button('使用默认版本', () => { row.versionId = defaultVersion(index.get(row.cardId)); row.status = 'ready'; row.message = '已明确使用默认版本'; refreshPreview(); }));
      if (row.status === 'ambiguous') {
        const chooser = select([['', '选择卡牌'], ...row.candidates.map(id => { const card = index.get(id); return [id, `${card.zhName || card.name} · ${card.name} · ${id.slice(0, 8)}`]; })], '');
        chooser.setAttribute('aria-label', `解决第 ${row.line} 行牌名歧义`); chooser.addEventListener('change', () => { if (!chooser.value) return; row.cardId = chooser.value; row.versionId = defaultVersion(index.get(chooser.value)); row.status = 'ready'; row.message = '已选择卡牌与默认版本'; refreshPreview(); }); actions.append(chooser);
      }
      const skip = input('', 'checkbox'); skip.checked = Boolean(row.skipped); skip.addEventListener('change', () => { row.skipped = skip.checked; refreshPreview(); }); const skipLabel = el('label', 'deck-check-label'); skipLabel.append(skip, el('span', '', '跳过此行')); actions.append(skipLabel);
      line.append(title, edit, actions);
      return line;
    }
    function refreshPreview() {
      preview.replaceChildren();
      if (jsonPreview) {
        preview.append(el('h3', '', `将新增 ${jsonPreview.decks.length} 套卡组`));
        for (const deck of jsonPreview.decks) preview.append(el('p', '', `${deck.name} · ${deck.entries.reduce((sum, entry) => sum + entry.quantity, 0)} 张（含候选）`));
        commitButton.disabled = false; return;
      }
      if (!textRows) return;
      const ambiguous = [], otherPending = [], completed = [];
      let ready = 0, skipped = 0;
      for (const row of textRows) {
        if (row.skipped) { completed.push(row); skipped++; }
        else if (row.status === 'ready') { completed.push(row); ready++; }
        else if (row.status === 'ambiguous') ambiguous.push(row);
        else otherPending.push(row);
      }
      const unresolved = ambiguous.length + otherPending.length;
      preview.append(el('h3', '', `${ready} 行可导入 · ${unresolved} 行待处理 · ${skipped} 行明确跳过`));
      for (const row of [...ambiguous, ...otherPending]) preview.append(importRow(row));
      const wasOpen = completedRows?.open ?? false;
      completedRows = null;
      if (completed.length) {
        completedRows = el('details', 'deck-import-completed');
        completedRows.open = wasOpen;
        const summary = [ready && `已匹配 ${ready} 行`, skipped && `已跳过 ${skipped} 行`].filter(Boolean).join(' · ');
        completedRows.append(el('summary', '', summary));
        for (const row of completed) completedRows.append(importRow(row));
        preview.append(completedRows);
      }
      commitButton.disabled = unresolved > 0 || ready === 0;
    }
    const previewButton = button('检查并预览', async () => {
      const revision = ++previewRevision, raw = source.value, inputFormat = format.value;
      error.hidden = true; previewButton.disabled = true; commitButton.disabled = true;
      try {
        let nextJSON = null, nextRows = null;
        if (inputFormat === 'json') {
          const structure = parseDeckBackup(raw);
          if (loadCardsByIds) {
            const entries = structure.decks.flatMap(deck => deck.entries);
            setCards(await loadCardsByIds([...new Set(entries.map(entry => entry.cardId))], { versions: entries.map(entry => ({ cardId: entry.cardId, versionId: entry.versionId })) }));
          } else if (loadDeckCards) {
            for (const deck of structure.decks) await ensureCards(deck);
          }
          nextJSON = parseDeckBackup(raw, cards);
        } else {
          const result = resolveDeckText ? await resolveDeckText(raw) : parseDeckText(raw, cards);
          if (result.cards) setCards(result.cards);
          nextRows = result.rows;
          if (!nextRows.length) throw new Error('没有可导入的牌表行');
        }
        if (revision !== previewRevision || !openModals.has(current)) return;
        jsonPreview = nextJSON; textRows = nextRows; completedRows = null;
        refreshPreview();
      } catch (err) {
        if (revision !== previewRevision || !openModals.has(current)) return;
        textRows = null; jsonPreview = null; preview.replaceChildren(); commitButton.disabled = true; notifyError(err, error);
      } finally { if (revision === previewRevision && openModals.has(current)) previewButton.disabled = false; }
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
  function render(expandAfterDrop = false) {
    deckDemo?.detach();
    if (!openModals.size) deferredLibraryRefresh = false;
    editorDrag?.dispose();
    editorDrag = undefined;
    disposeAddSearch?.();
    disposeAddSearch = undefined;
    container.replaceChildren();
    if (openingId) {
      deckDemo?.stop();
      const pendingId = openingId;
      container.append(button('← 卡组库', showLibrary), el('h1', '', store.get(pendingId)?.name || '卡组编辑'));
      if (syncController) container.append(status());
      const message = el('p', openingError ? 'deck-form-error' : 'deck-muted', openingError ? `卡牌数据加载失败：${openingError.message}` : '正在加载卡牌数据…'); message.setAttribute('role', 'status'); container.append(message);
      if (openingError) container.append(button('重新加载', () => { void openDeck(pendingId); }, 'button button-primary'));
      return;
    }
    const deck = selectedId ? store.get(selectedId) : null;
    if (deck && analysisOpen) {
      deckDemo?.stop();
      if (syncController) container.append(status());
      container.append(createDeckAnalysis({
        deck, cards, onInspect,
        onBack: () => {
          analysisOpen = false;
          render();
          container.querySelector('[data-deck-analysis]')?.focus();
        },
      }));
    } else if (deck) renderEditor(deck, expandAfterDrop === true);
    else { deckDemo?.stop(); selectedId = null; staleDeckId = null; renderLibrary(); }
  }
  function showLibrary() {
    ++openRequest; openingId = null; openingError = null; selectedId = null; analysisOpen = false; staleDeckId = null; render();
    void syncController?.sync();
  }
  render();
  if (syncController) void syncController.start();
  function destroy() {
    document.removeEventListener('pointerdown', dismissCardMenus, true);
    document.removeEventListener('keydown', escapeCardMenu, true);
    ++openRequest;
    syncController?.dispose();
    deferredLibraryRefresh = false;
    deckDemo?.dispose();
    editorDrag?.dispose(); editorDrag = undefined;
    disposeAddSearch?.(); disposeAddSearch = undefined;
    for (const current of [...openModals]) current.close();
    container.replaceChildren();
  }
  return { render, addCard, quickAddCard, changeEntryVersion, isFiveDhEnabled: id => fiveDhDecks.has(id), showLibrary, setCards, openDeck, listDecks: () => store.list(), getDeck: id => store.get(id), getSelectedDeckId: () => selectedId, cancelEditorDrag: () => editorDrag?.cancel(), stopDeckDemo: () => deckDemo?.stop(), flushCloudDecks: () => syncController?.sync(false), destroy };
}
