import { loadCatalog } from './lib/catalog.js';
import { searchCards, validateSearch, extractSearchOptions } from './lib/search.js';
import { initDeckUI } from './lib/deck-ui.js';
import { initSearchFilters } from './lib/filter-ui.js';
import { getCommanderIdentity } from './lib/decks.js';
import { resolveDeckTarget, catalogQueryFromDeckSearch, commanderScopeQuery } from './lib/deck-target.js';
import { buildDeckMembership } from './lib/deck-membership.js';
import { clauseRange, syncQueryClauses, SORT_QUERIES } from './lib/query-sync.js';
import { hasCatalogQueryIntent } from './lib/catalog-query-policy.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const PAGE_SIZE = 48;
const COLOR_NAMES = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿', C: '无色' };
const MANA_GLYPHS = { W: '☀', U: '◆', B: '●', R: '◆', G: '♣', C: '◇', T: '↷', Q: '↶', E: 'ϟ', S: '❄' };
let allCards = [];
let manifest = null;
let deckUI = null;
let playtestUI = null;
let playtestModule = null;
let matchedCards = [];
let renderedCount = 0;
let currentView = 'decks';
let catalogTargetId = null;
let catalogScopeEnabled = true;
let knownSetCodes = new Set();
let resultView = 'grid';
let detailCard = null;
let detailVersion = null;
let detailLanguage = 'zh';
let previousFocus = null;
let searchTimer = null;
let loading = false;
let catalogPromise = null;
let searchRevision = 0;
let mobileFilterFocus = null;
let filterUI = null;
let generatedClause = '';
let scopeClause = '';
let catalogMembership = new Map();

function synchronizeQuery() {
  if (!filterUI) return;
  const input = $('#search-input'), visual = filterUI.getSearch();
  try { const result = syncQueryClauses(input.value, { oldVisual: generatedClause, visual: visual.displayQuery, oldScope: scopeClause, scope: currentCommanderScope(), fallbackSort: $('#sort-select').value }); input.value = result.query; generatedClause = result.generatedClause; scopeClause = result.scopeClause; }
  catch { /* Keep incomplete handwritten syntax available for correction. */ }
}

function acceptQueryEdit() {
  const text = $('#search-input').value;
  if (generatedClause && !clauseRange(text, generatedClause)) { filterUI.clear({ commanderOnly: filterUI.getSearch().filters.commanderOnly, silent: true }); generatedClause = ''; }
  if (scopeClause && !clauseRange(text, scopeClause)) { scopeClause = ''; catalogScopeEnabled = false; $('#catalog-scope-filter').checked = false; }
  try { const options = extractSearchOptions(text, 'name'); if (SORT_QUERIES[options.sort]) $('#sort-select').value = options.sort; } catch { /* Search validation shows the exact error. */ }
}

function hasCatalogSearchIntent() {
  const visual = filterUI.getSearch();
  return hasCatalogQueryIntent($('#search-input').value, { generatedClause, scopeClause, hasUserConditions: visual.hasUserConditions, error: visual.error });
}

function node(tag, attrs = {}, children = []) {
  const item = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') item.className = value;
    else if (key === 'text') item.textContent = value ?? '';
    else if (key === 'onClick') item.addEventListener('click', value);
    else if (value !== undefined && value !== null && value !== false) item.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    item.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return item;
}

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function manaSymbol(symbol) {
  const normalized = String(symbol).toUpperCase();
  const kind = normalized.includes('/') ? 'hybrid' : /^[WUBRGC]$/.test(normalized) ? normalized.toLowerCase() : 'c';
  const item = node('span', { class: 'mana-symbol mana-' + kind, title: '{' + normalized + '}', 'aria-label': '{' + normalized + '}', text: MANA_GLYPHS[normalized] || normalized });
  return item;
}

function manaCost(value) {
  const wrap = node('span', { class: 'mana-symbols', 'aria-label': value || '无法术力费用' });
  const symbols = String(value || '').match(/\{([^}]+)\}/g) || [];
  for (const symbol of symbols) wrap.append(manaSymbol(symbol.slice(1, -1)));
  return wrap;
}

function ruleText(value, className) {
  const wrap = node('p', { class: 'rule-text' + (className ? ' ' + className : '') });
  const pieces = String(value || '').split(/(\{[^}]+\})/g);
  for (const piece of pieces) {
    if (/^\{[^}]+\}$/.test(piece)) wrap.append(manaSymbol(piece.slice(1, -1)));
    else wrap.append(document.createTextNode(piece));
  }
  return wrap;
}

function fmt(value) { return Number(value || 0).toLocaleString('zh-CN'); }
function cardName(card) { return card.zhName || card.name || '未命名卡牌'; }
function cardFaces(card) { return card.faces?.length ? card.faces : [card]; }
function sourceLabel(source) {
  if (!source) return '来源待标注';
  if (typeof source === 'object') return sourceLabel(source.name || source.label || source.id || source.type);
  const labels = { official: '官方中文', community: '社区译文', ai: 'AI 译文', gpt: '社区资料中的 AI 译文', MTGZH: 'MTGZH 社区译文', 'magic-cards-zhs': 'magic-cards-zhs 社区中文', 'mtgjson-zhs': 'MTGJSON 官方中文印刷', scryfall: 'Scryfall', oracle: 'Oracle' };
  return labels[source] || String(source);
}
function hasChineseText(card) {
  const faces = cardFaces(card);
  return faces.every((face) => !face.oracleText || Boolean(face.zhText));
}
function selectedVersionFor(card) {
  return card.matchingVersions?.[0]
    || card.versions?.find((version) => version.id === card.defaultVersionId)
    || card.versions?.find((version) => version.set === card.set && String(version.collectorNumber) === String(card.collectorNumber) && (!card.lang || version.lang === card.lang))
    || card.versions?.[0]
    || null;
}

function imageFrame(imageURL, name, className = 'card-image-button', clickable = false) {
  const wrap = node(clickable ? 'button' : 'div', { class: className });
  if (clickable) {
    wrap.type = 'button';
    wrap.setAttribute('aria-label', '查看 ' + name + ' 详情');
  }
  const placeholder = node('div', { class: 'image-placeholder', 'aria-hidden': 'true' }, [icon('image'), node('span', { text: imageURL ? '卡图加载中' : '暂无该版本卡图' }), node('small', { text: name })]);
  wrap.append(placeholder);
  if (imageURL && /^https?:\/\//i.test(imageURL)) {
    const img = node('img', { class: 'card-image', src: imageURL, alt: name, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      img.classList.add('is-loaded');
      placeholder.hidden = true;
    });
    img.addEventListener('error', () => {
      img.hidden = true;
      wrap.classList.add('image-unavailable');
      $('span', placeholder).textContent = '卡图暂时无法载入';
    }, { once: true });
    wrap.append(img);
  }
  return wrap;
}

function notify(message, type = 'info') {
  if (!message) return;
  const toast = node('div', { class: 'toast' + (type === 'error' ? ' error' : ''), role: type === 'error' ? 'alert' : 'status' }, [icon(type === 'error' ? 'info' : 'check'), node('span', { text: message })]);
  $('#toast-stack').append(toast);
  setTimeout(() => toast.remove(), type === 'error' ? 6500 : 3800);
}

function renderCard(card) {
  const article = node('article', { class: 'card-tile', 'data-card-id': card.id });
  const version = selectedVersionFor(card);
  const image = imageFrame(version?.image || card.image || cardFaces(card)[0]?.image, cardName(card), 'card-image-button', true);
  image.addEventListener('click', () => openDetail(card));
  if (cardFaces(card).length > 1) image.append(node('span', { class: 'card-top-badge', text: cardFaces(card).length + ' 个牌面' }));
  const title = node('button', { class: 'card-title', type: 'button', text: cardName(card), title: cardName(card), onClick: () => openDetail(card) });
  const add = node('button', { class: 'add-card-button', type: 'button', 'aria-label': '将 ' + cardName(card) + ' 加入卡组', title: '加入卡组', onClick: () => addCard(card, version) }, icon('plus'));
  const type = node('p', { class: 'card-type' }, [node('span', { text: card.zhTypeLine || card.typeLine || '类别待补全' }), manaCost(card.manaCost)]);
  const set = node('div', { class: 'card-set' }, [node('span', { class: 'set-code', text: version?.set || card.set || '—' }), node('span', { text: (version?.collectorNumber || card.collectorNumber) ? '#' + (version?.collectorNumber || card.collectorNumber) : '' })]);
  if (!hasChineseText(card)) set.append(node('span', { class: 'card-translation-missing', text: '中文待补' }));
  else if (card.translation?.stale || cardFaces(card).some((face) => face.translation?.stale)) set.append(node('span', { class: 'card-translation-missing', text: '译文待更新' }));
  const info = node('div', { class: 'card-info' }, [title, node('p', { class: 'card-english', text: card.name, title: card.name }), add, type, set]);
  info.append(node('p', { class: 'card-membership', text: catalogMembership.get(card.id)?.label || '', hidden: !catalogMembership.has(card.id) }));
  article.append(image, info);
  return article;
}

function setResultState({ title, message, kind = 'search', action } = {}) {
  const state = $('#result-state');
  state.replaceChildren();
  if (kind === 'loading') state.append(node('div', { class: 'loading-spinner', 'aria-hidden': 'true' }));
  else state.append(icon(kind));
  state.append(node('h2', { text: title }), node('p', { text: message, id: kind === 'loading' ? 'loading-message' : undefined }));
  if (action) state.append(node('button', { class: 'button', text: action.label, onClick: action.run }));
  state.hidden = false;
}

function appendResults() {
  const fragment = document.createDocumentFragment();
  const next = matchedCards.slice(renderedCount, renderedCount + PAGE_SIZE);
  for (const card of next) fragment.append(renderCard(card));
  $('#results').append(fragment);
  renderedCount += next.length;
  $('#load-more').hidden = renderedCount >= matchedCards.length;
  $('#load-more').textContent = '继续载入 · 已显示 ' + fmt(renderedCount) + ' / ' + fmt(matchedCards.length);
  $('#result-end').hidden = !matchedCards.length || renderedCount < matchedCards.length;
}

function renderActiveFilters() {
  filterUI.renderActiveFilters();
}

function showIdleCatalog() {
  $('#catalog-view').classList.add('is-idle');
  $('#results').replaceChildren();
  $('#results').setAttribute('aria-busy', 'false');
  $('#result-state').hidden = true;
  $('#search-error').hidden = true;
  $('#load-more').hidden = true;
  $('#result-end').hidden = true;
  $('#results-count').textContent = '';
  filterUI.showError(null);
  matchedCards = [];
  renderedCount = 0;
}

async function runSearch() {
  clearTimeout(searchTimer);
  const revision = ++searchRevision;
  if (currentView !== 'catalog') return;
  const query = $('#search-input').value.trim();
  const visual = filterUI.getSearch();
  if (!hasCatalogSearchIntent()) { renderActiveFilters(); showIdleCatalog(); return; }
  const wasIdle = $('#catalog-view').classList.contains('is-idle');
  $('#catalog-view').classList.remove('is-idle');
  if (wasIdle && !window.matchMedia('(max-width: 700px)').matches) {
    $('#catalog-view').classList.remove('filters-collapsed');
    $('#filter-toggle').setAttribute('aria-expanded', 'true');
  }
  const combinedQuery = query;
  const errorBox = $('#search-error');
  let result;
  try {
    const validationError = visual.error ? { message: visual.error } : validateSearch(combinedQuery, { commanderOnly: visual.filters.commanderOnly });
    if (!validationError && !manifest) {
      renderActiveFilters();
      filterUI.showError(null);
      errorBox.hidden = true;
      $('#results').replaceChildren();
      $('#results').setAttribute('aria-busy', 'true');
      $('#load-more').hidden = true;
      $('#result-end').hidden = true;
      $('#results-count').textContent = '正在加载搜索数据…';
      $('#data-status-text').textContent = '首次搜索正在准备卡库，后续搜索会复用已加载的数据。';
      setResultState({ title: '正在准备搜索', message: '载入中文卡牌与印刷版本…', kind: 'loading' });
      const ready = await ensureCatalog();
      if (ready && revision === searchRevision && currentView === 'catalog') runSearch();
      return;
    }
    result = validationError ? { cards: [], total: 0, error: validationError } : searchCards(allCards, combinedQuery, { commanderOnly: visual.filters.commanderOnly }, $('#sort-select').value);
  } catch (error) {
    result = { cards: [], total: 0, error: { message: error.message || '检索出现问题，请修改条件后重试。', rawPosition: error.position } };
  }
  renderActiveFilters();
  $('#results').setAttribute('aria-busy', 'false');
  filterUI.showError(result.error?.message);
  $('#results').replaceChildren();
  $('#result-state').hidden = true;
  $('#load-more').hidden = true;
  $('#result-end').hidden = true;
  errorBox.hidden = !result.error;
  if (result.error) {
    const position = Number.isInteger(result.error.rawPosition) ? '（搜索框第 ' + (result.error.rawPosition + 1) + ' 个字符附近）' : '';
    errorBox.textContent = result.error.message + position;
    $('#results-count').textContent = '搜索条件需要调整';
    setResultState({ title: '检查一下搜索条件', message: '请调整上面的搜索内容或筛选条件，也可以在高级搜索中逐项选择。', kind: 'help', action: { label: '打开高级搜索', run: showAdvancedFilters } });
    matchedCards = [];
    return;
  }
  matchedCards = result.cards || [];
  renderedCount = 0;
  const count = result.total ?? matchedCards.length;
  $('#results-count').replaceChildren(node('strong', { text: fmt(count) }), document.createTextNode(query || $('#active-filters').children.length ? '张匹配卡牌' : '张卡牌'));
  if (!matchedCards.length) {
    setResultState({ title: '还没有找到这张牌', message: '试试其他牌名、规则片段，或减少筛选条件。当前功能标签尚在扩充，详情见数据说明。', kind: 'search', action: { label: '清空搜索与筛选', run: clearSearch } });
    return;
  }
  appendResults();
}

function resetFilters() {
  filterUI.reset();
}

function clearSearch() { $('#search-input').value = ''; generatedClause = ''; scopeClause = ''; catalogScopeEnabled = false; $('#catalog-scope-filter').checked = false; $('#sort-select').value = 'name'; resetFilters(); }
function setQuery(query) {
  filterUI.clear({ commanderOnly: true, silent: true }); generatedClause = ''; scopeClause = ''; catalogScopeEnabled = false; $('#catalog-scope-filter').checked = false;
  $('#search-input').value = query;
  synchronizeQuery();
  $$('dialog[open]').forEach((dialog) => dialog.close());
  switchView('catalog');
  $('#search-input').focus();
}

function openFilters() {
  const layout = $('#catalog-view');
  if (window.matchMedia('(max-width: 700px)').matches) {
    mobileFilterFocus = document.activeElement;
    layout.classList.add('filters-mobile-open');
    $('#filter-scrim').hidden = false;
    $('#filters').setAttribute('role', 'dialog');
    $('#filters').setAttribute('aria-modal', 'true');
    document.body.classList.add('modal-open');
    $('#filter-close').focus();
    $('#filter-toggle').setAttribute('aria-expanded', 'true');
  } else {
    const collapsed = layout.classList.toggle('filters-collapsed');
    $('#filter-toggle').setAttribute('aria-expanded', String(!collapsed));
  }
}

function closeFilters() {
  $('#catalog-view').classList.remove('filters-mobile-open');
  $('#catalog-view').classList.remove('idle-filters-open');
  $('#filter-scrim').hidden = true;
  $('#filters').removeAttribute('role');
  $('#filters').removeAttribute('aria-modal');
  if ($('#detail-layer').hidden && !$('.deck-modal-overlay')) document.body.classList.remove('modal-open');
  if (window.matchMedia('(max-width: 700px)').matches) $('#filter-toggle').setAttribute('aria-expanded', 'false');
  mobileFilterFocus?.focus();
  mobileFilterFocus = null;
}

function showAdvancedFilters() {
  $('#catalog-view').classList.add('idle-filters-open');
  filterUI.setMode('advanced');
  if (window.matchMedia('(max-width: 700px)').matches) {
    if (!$('#catalog-view').classList.contains('filters-mobile-open')) openFilters();
  } else {
    $('#catalog-view').classList.remove('filters-collapsed');
    $('#filter-toggle').setAttribute('aria-expanded', 'true');
  }
}

function switchView(view) {
  closeFilters();
  currentView = view;
  $('#catalog-view').hidden = view !== 'catalog';
  $('#deck-view').hidden = view !== 'decks';
  $('#playtest-view').hidden = view !== 'playtest';
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === (view === 'playtest' ? 'decks' : view);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (view === 'decks') {
    if (deckUI) deckUI.render();
    else initializeDeckWorkspace();
  } else if (view === 'catalog') {
    runSearch();
  }
}

function initializeDeckWorkspace() {
  try {
    if (deckUI) deckUI.setCards(allCards);
    else deckUI = initDeckUI({ container: $('#deck-view'), cards: allCards, onInspect: openDetail, onNotify: notify,
      loadCards: async () => { if (!await ensureCatalog()) throw new Error('卡库载入失败，请重试。'); return allCards; },
      onOpenCatalog: openCatalogFromDeck, onLibraryChange: refreshCatalogTarget, onPlaytest: openPlaytest });
    refreshCatalogTarget();
  } catch (error) {
    $('#deck-view').replaceChildren(node('div', { class: 'result-state' }, [icon('info'), node('h2', { text: '卡组工作台暂时无法载入' }), node('p', { text: error.message || '请重试。' }), node('button', { class: 'button', text: '重试', onClick: initializeDeckWorkspace })]));
    console.error('Deck workspace initialization failed', error);
  }
}

async function openPlaytest(deck) {
  try {
    if (!deck) throw new Error('卡组已不存在，请重新选择。');
    if (!await ensureCatalog()) return;
    playtestModule ||= import('./lib/playtest-ui.js').catch(error => { playtestModule = null; throw error; });
    const { initPlaytestUI } = await playtestModule;
    playtestUI ||= initPlaytestUI({ container: $('#playtest-view'), cards: allCards, onInspect: openDetail, onExit: () => switchView('decks'), onNotify: notify });
    playtestUI.open(deck);
    switchView('playtest');
    window.scrollTo({ top: 0, behavior: 'instant' });
  } catch (error) { notify(error.message || '手动测试暂时无法打开，请重试。', 'error'); }
}

async function addCard(card, version) {
  if (currentView === 'playtest') return;
  if (!deckUI) { notify(loading ? '卡库仍在加载，请稍候。' : '卡组工作台暂时不可用，请刷新后重试。', 'error'); return; }
  try {
    const targetId = currentView === 'decks' ? deckUI.getSelectedDeckId() : catalogTargetId;
    const target = resolveDeckTarget(deckUI.listDecks(), targetId);
    if (targetId && !target) { if (currentView === 'catalog') catalogTargetId = null; refreshCatalogTarget(); notify('目标卡组已不存在，请重新选择。', 'error'); return; }
    if (target) deckUI.quickAddCard(card, version, target.id);
    else await deckUI.addCard(card, version);
  } catch (error) {
    notify(error.message || '卡牌暂时无法加入卡组，请重试。', 'error');
  }
}

function currentAddTarget() {
  const id = currentView === 'decks' ? deckUI?.getSelectedDeckId() : catalogTargetId;
  return deckUI && resolveDeckTarget(deckUI.listDecks(), id);
}

function currentCommanderScope() {
  const target = deckUI && resolveDeckTarget(deckUI.listDecks(), catalogTargetId);
  return target && catalogScopeEnabled ? commanderScopeQuery(getCommanderIdentity(target, allCards)) : '';
}

function refreshCatalogTarget() {
  const decks = deckUI?.listDecks() || [];
  const target = resolveDeckTarget(decks, catalogTargetId);
  if (catalogTargetId && !target) catalogTargetId = null;
  const picker = $('#catalog-target-select');
  picker.replaceChildren(node('option', { value: '', text: '未选择（添加时询问）' }));
  for (const deck of decks) picker.append(node('option', { value: deck.id, text: deck.name }));
  picker.value = catalogTargetId || '';
  $('#catalog-target-label').textContent = target ? '添加到「' + target.name + '」· 主牌区' : '未选择添加目标 · 添加时选择卡组';
  $('#catalog-target-toggle').textContent = target ? '切换目标卡组' : '选择目标卡组';
  $('#catalog-return-deck').hidden = !target;
  const identity = target ? getCommanderIdentity(target, allCards) : null;
  $('#catalog-scope-label').hidden = identity === null;
  $('#catalog-scope-filter').checked = catalogScopeEnabled;
  $('#catalog-scope-text').textContent = '按主将标识色限制搜索：' + (identity?.map(color => COLOR_NAMES[color]).join(' / ') || '无色');
  $$('.add-card-button').forEach(button => { button.title = target ? '加入「' + target.name + '」主牌区' : '选择卡组并加入'; });
  const detailTarget = currentAddTarget();
  $$('.detail-add').forEach(button => { button.textContent = detailTarget ? '加入「' + detailTarget.name + '」主牌区' : '选择卡组并加入'; });
  catalogMembership = buildDeckMembership(decks, catalogTargetId);
  $$('#results .card-tile').forEach(tile => { const badge = $('.card-membership', tile), item = catalogMembership.get(tile.dataset.cardId); if (badge) { badge.textContent = item?.label || ''; badge.hidden = !item; } });
  synchronizeQuery();
}

function openCatalogFromDeck({ deckId, query = '', restrictIdentity = true }) {
  catalogTargetId = deckId;
  catalogScopeEnabled = restrictIdentity;
  filterUI.clear({ commanderOnly: true, silent: true }); generatedClause = ''; scopeClause = '';
  filterUI.setMode('advanced');
  $('#search-input').value = catalogQueryFromDeckSearch(query, knownSetCodes);
  refreshCatalogTarget();
  switchView('catalog');
  showAdvancedFilters();
  if (!window.matchMedia('(max-width: 700px)').matches) $('#search-input').focus();
}

function openDetail(card, version = null) {
  if (!card) return;
  previousFocus = document.activeElement;
  detailCard = card;
  detailVersion = version || selectedVersionFor(card);
  detailLanguage = 'zh';
  renderDetail();
  $('#detail-content').scrollTop = 0;
  $('#detail-layer').hidden = false;
  document.body.classList.add('modal-open');
  $('#detail-close').focus();
}

function closeDetail() {
  $('#detail-layer').hidden = true;
  if (!$('#catalog-view').classList.contains('filters-mobile-open')) document.body.classList.remove('modal-open');
  if (previousFocus?.isConnected) previousFocus.focus();
  detailCard = null;
  detailVersion = null;
}

function translationNote(face) {
  const translation = face.translation || detailCard?.translation || {};
  const required = Boolean(face.oracleText);
  let message;
  let good = false;
  if (!required) { message = '本牌面无 Oracle 规则文字。'; good = true; }
  else if (!face.zhText) message = '中文规则待补齐 · 暂时保留英文原文，未计为中文已覆盖。';
  else if (translation.stale) message = sourceLabel(translation.source) + ' · 英文规则已更新，中文待复核。';
  else if (translation.override) message = sourceLabel(translation.source) + ' · 项目 AI 辅助修订 · 待人工复核。';
  else {
    message = sourceLabel(translation.source);
    if (translation.upstreamAI || translation.status === 'ai' || ['ai', 'gpt'].includes(translation.source)) message += ' · 待人工复核。';
    else if (['reviewed', 'verified', 'approved'].includes(translation.reviewStatus || translation.status)) message += ' · 已复核';
    else message += ' · 可对照英文核实';
    good = true;
  }
  return node('div', { class: 'translation-note' + (good ? ' good' : '') }, [icon('info'), node('span', { text: message })]);
}

function renderFaceRules(face, index, multiple) {
  const content = node('section', { class: 'face-rule', 'aria-label': (face.zhName || face.name || '牌面') + '规则文字' });
  const isEnglish = detailLanguage === 'en';
  if (multiple) content.append(node('h4', { class: 'face-rule-title' }, [node('span', { text: (isEnglish ? face.name : face.zhName || face.name) || '牌面 ' + (index + 1) }), manaCost(face.manaCost)]));
  const type = isEnglish ? face.typeLine : face.zhTypeLine || face.typeLine;
  if (type) content.append(node('p', { class: 'face-rule-type', text: type }));
  if (isEnglish) {
    content.append(face.oracleText ? ruleText(face.oracleText) : node('p', { class: 'detail-empty-text', text: 'No Oracle rules text.' }));
  } else {
    if (face.zhText) content.append(ruleText(face.zhText));
    else if (face.oracleText) content.append(node('p', { class: 'translation-missing', text: '这张牌面的中文规则尚待补齐。以下为英文原文。' }), ruleText(face.oracleText, 'rule-text-en'));
    else content.append(node('p', { class: 'detail-empty-text', text: '此牌面没有规则文字。' }));
    if (detailLanguage === 'compare' && face.zhText && face.oracleText) content.append(node('div', { class: 'translation-separator' }), node('p', { class: 'rule-language-label', text: 'ORACLE · ENGLISH' }), ruleText(face.oracleText, 'rule-text-en'));
  }
  content.append(translationNote(face));
  return content;
}

function renderDetail() {
  if (!detailCard) return;
  const card = detailCard;
  const faces = cardFaces(card);
  const version = detailVersion;
  const root = $('#detail-content');
  const oldScroll = root.scrollTop;
  root.replaceChildren();
  const images = node('div', { class: 'detail-images' + (faces.length > 1 ? ' multi' : '') });
  const isDefaultPrinting = !version || version.id === card.defaultVersionId || (!card.defaultVersionId && version.set === card.set && String(version.collectorNumber) === String(card.collectorNumber));
  const faceImages = faces.map((face, index) => version?.faceImages?.[index] || (index === 0 ? version?.image || card.image || face.image : isDefaultPrinting ? face.image : null));
  const mainImage = imageFrame(version?.image || card.image || faces[0]?.image, cardName(card), 'detail-image-wrap');
  const mainImgElement = $('img', mainImage);
  if (mainImgElement) mainImgElement.loading = 'eager';
  images.append(mainImage);
  if (faces.length > 1) {
    const thumbs = node('div', { class: 'detail-face-images' });
    faces.forEach((face, index) => {
      const thumb = imageFrame(faceImages[index], face.zhName || face.name, 'card-image-button detail-image-wrap', true);
      thumb.setAttribute('aria-label', '查看牌面：' + (face.zhName || face.name));
      thumb.addEventListener('click', () => {
        const next = imageFrame(faceImages[index], face.zhName || face.name, 'detail-image-wrap');
        const img = $('img', next);
        if (img) img.loading = 'eager';
        images.firstElementChild.replaceWith(next);
      });
      thumbs.append(thumb);
    });
    images.append(thumbs);
  }
  const meta = node('div', { class: 'detail-meta' });
  meta.append(node('h2', { id: 'detail-name', text: cardName(card) }), node('p', { class: 'detail-en-name', text: card.name }), manaCost(card.manaCost), node('p', { class: 'detail-type', text: card.zhTypeLine || card.typeLine || '类别待补全' }));
  const facts = node('dl', { class: 'detail-facts' });
  facts.append(node('div', {}, [node('dt', { text: '法术力值' }), node('dd', { text: Number.isFinite(card.manaValue) ? card.manaValue : '—' })]));
  const colors = (card.colorIdentity || []).map((color) => COLOR_NAMES[color] || color).join(' / ') || '无色';
  facts.append(node('div', {}, [node('dt', { text: '标识色' }), node('dd', { text: colors })]));
  meta.append(facts);
  const legality = card.legalities?.commander;
  const legalityLabel = legality === 'legal' ? 'EDH 合法' : legality === 'banned' ? 'EDH 禁用' : legality === 'not_legal' ? 'EDH 不合法' : legality === 'restricted' ? 'EDH 限制' : 'EDH 合法性未知';
  meta.append(node('span', { class: 'legality-pill' + (legality === 'legal' ? '' : legality ? ' bad' : ' unknown') }, [icon(legality === 'legal' ? 'check' : 'info'), legalityLabel]));
  if (card.tags?.length) {
    const tagNames = { draw: '抓牌', ramp: '加速', 'tutor-land': '找地', 'spot-removal': '单体去除', sweeper: '清场', counterspell: '反击', recursion: '坟场回收', 'hate-graveyard': '坟场针对', 'castable-from-graveyard': '可从坟场施放' };
    const tags = card.tags.map((tag) => typeof tag === 'string' ? tag : tag.label || tag.name || tag.id);
    const primaryTags = tags.filter((tag) => tagNames[tag]);
    meta.append(node('div', { class: 'detail-tags' }, (primaryTags.length ? primaryTags : tags.slice(0, 4)).map((tag) => node('span', { text: tagNames[tag] || tag }))));
    if (tags.length > primaryTags.length) meta.append(node('details', { class: 'detail-more-tags' }, [node('summary', { text: '查看全部 ' + tags.length + ' 个标签' }), node('div', { class: 'detail-tags' }, tags.map((tag) => node('span', { text: tagNames[tag] || tag })))]));
  }
  root.append(node('div', { class: 'detail-overview' }, [images, meta]));
  const language = node('div', { class: 'language-toggle', role: 'group', 'aria-label': '规则显示语言' });
  for (const [value, label] of [['zh', '中文'], ['compare', '中英对照'], ['en', 'English']]) language.append(node('button', { class: detailLanguage === value ? 'active' : '', type: 'button', 'aria-pressed': detailLanguage === value, text: label, onClick: () => { detailLanguage = value; renderDetail(); } }));
  root.append(node('div', { class: 'detail-language-bar' }, [node('h3', { text: '规则文字' + (faces.length > 1 ? ' · ' + faces.length + ' 个牌面' : '') }), language]));
  faces.forEach((face, index) => root.append(renderFaceRules(face, index, faces.length > 1)));
  const versions = card.versions?.length ? card.versions : [{ id: card.id, set: card.set, collectorNumber: card.collectorNumber, releasedAt: card.releasedAt, image: card.image }];
  const versionSelect = node('select', { class: 'version-select', id: 'detail-version', 'aria-label': '印刷版本' });
  versions.forEach((item, index) => versionSelect.append(node('option', { value: index, text: [(item.set || '未知系列').toUpperCase(), item.setName || '', item.collectorNumber ? '#' + item.collectorNumber : '', item.lang ? item.lang.toUpperCase() : '', item.releasedAt || ''].filter(Boolean).join(' · ') })));
  const versionIndex = versions.findIndex((item) => item.id === version?.id);
  versionSelect.value = String(Math.max(0, versionIndex));
  versionSelect.addEventListener('change', () => { detailVersion = versions[Number(versionSelect.value)]; renderDetail(); });
  root.append(node('section', { class: 'version-section' }, [node('label', { class: 'version-heading', for: 'detail-version' }, ['印刷版本', node('span', { text: fmt(versions.length) + ' 个已收录版本' })]), versionSelect, node('p', { class: 'version-caption', text: (card.matchingVersions?.length ? '已优先选择符合当前检索条件的版本。' : '') + '加入卡组时使用此版本。当前收录默认语言印刷和已映射中文印刷，全部语言版本仍待补充。' })]));
  const addTarget = currentAddTarget();
  if (currentView !== 'playtest') root.append(node('button', { class: 'button button-primary detail-add', type: 'button', onClick: () => addCard(card, detailVersion || versions[0]) }, [icon('plus'), addTarget ? '加入「' + addTarget.name + '」主牌区' : '选择卡组并加入']));
  root.append(node('p', { class: 'detail-footer-note', text: '中文内容保留译文来源，牌面与规则以英文 Oracle 为核对依据。卡图通过 Scryfall 载入。' }));
  root.scrollTop = oldScroll;
}

function renderDataStatus() {
  const coverage = manifest?.coverage;
  const required = coverage?.requiredFaces;
  const translated = coverage?.translatedFaces;
  const hasCoverage = Number.isFinite(required) && required >= 0 && Number.isFinite(translated) && translated >= 0;
  const coveragePercent = hasCoverage ? (required ? Math.min(100, translated / required * 100) : 100).toFixed(1).replace(/\.0$/, '') : null;
  $('#data-status-text').textContent = hasCoverage ? '数据接入预览 · 中文规则文字覆盖 ' + coveragePercent + '%' + (required > translated ? ' · ' + fmt(required - translated) + ' 个牌面待补齐' : ' · 人工复核待完成') : '数据接入预览 · 中文覆盖统计待生成 · 缺译内容正在核查';
  const tagged = allCards.filter((card) => card.tags?.length).length;
  $('#tag-coverage').textContent = tagged ? '来自 Scryfall Oracle Tags，覆盖 ' + fmt(tagged) + ' 张牌；未分类卡牌可继续用规则文字检索。' : '当前快照尚无功能标签数据。tag: 语法已提供，标签覆盖仍待接入。';
  const content = $('#data-dialog-content');
  content.replaceChildren();
  content.append(node('div', { class: 'data-facts' }, [node('div', { class: 'data-fact' }, [node('strong', { text: fmt(allCards.length) }), node('span', { text: '独立卡牌身份' })]), node('div', { class: 'data-fact' }, [node('strong', { text: coveragePercent !== null ? coveragePercent + '%' : '待统计' }), node('span', { text: '中文规则覆盖率' })]), node('div', { class: 'data-fact' }, [node('strong', { text: fmt(tagged) }), node('span', { text: '已有功能标签' })])]));
  content.append(node('p', { class: 'data-note', text: '当前为数据接入预览。中文覆盖、复杂牌面翻译复核与功能标签仍需继续补齐，通过固定验收案例后才会标记为版本完成。' }));
  if (hasCoverage) content.append(node('p', { class: 'data-note', text: '规则文字必需牌面 ' + fmt(required) + ' 个，已有中文 ' + fmt(translated) + ' 个，缺失 ' + fmt(Math.max(0, required - translated)) + ' 个。原文无规则文字的牌面单独统计。' }));
  const date = manifest?.freezeDate || manifest?.snapshotDate || manifest?.generatedAt || manifest?.builtAt || manifest?.updatedAt || manifest?.date;
  if (date) content.append(node('p', { class: 'data-note', text: '卡池冻结日期：' + String(date).slice(0, 10) + (manifest?.snapshot ? ' · 英文 ' + String(manifest.snapshot.oracleDate || '').slice(0, 10) + ' · 中文 ' + String(manifest.snapshot.chineseDate || '').slice(0, 10) : '') }));
  if (manifest?.translationReview?.upstreamAIFaces) content.append(node('p', { class: 'data-note', text: '社区快照含 ' + fmt(manifest.translationReview.upstreamAIFaces) + ' 个 AI 译文牌面，已保留来源与待复核标记。覆盖率只统计中文规则是否非空，人工语义复核另行验收。' }));
  const list = node('ul', { class: 'data-source-list' });
  list.append(node('li', {}, ['英文身份、Oracle 与印刷版本：', node('a', { href: 'https://scryfall.com/docs/api', target: '_blank', rel: 'noreferrer', text: 'Scryfall' })]));
  list.append(node('li', {}, ['中文内容：', node('a', { href: 'https://github.com/HeliumOctahelide/magic-cards-zhs', target: '_blank', rel: 'noreferrer', text: 'magic-cards-zhs 社区资料' }), '，详细来源以牌面标注为准。']));
  list.append(node('li', { text: '中文缺失会保留英文，过期译文会单独标记。当前未将未覆盖牌面视为验收通过。' }));
  content.append(list);
  if (manifest?.versionCoverage?.allLanguagesSnapshotLoaded === false) content.append(node('p', { class: 'data-note', text: '版本范围：当前默认语言纸牌印刷及社区映射的中文印刷。全部语言的印刷版本尚未接入，因此 lang: 筛选只作用于已收录版本。' }));
  if (manifest?.searchMetadata) content.append(node('p', { class: 'data-note', text: 'EDHREC 排名采用 ' + String(manifest.searchMetadata.oracleDate).slice(0, 10) + ' 的 Scryfall 数据快照，' + fmt(manifest.searchMetadata.rankedCards) + ' 张牌有排名；排名较小的牌优先，未排名的牌排在末尾。力量与防御力按每个牌面的原始数值查询，* 等未定值不计入数值范围。' }));
  if (manifest?.reports?.coverage) content.append(node('p', { class: 'data-note' }, node('a', { href: './data/' + manifest.reports.coverage, target: '_blank', rel: 'noreferrer', text: '查看本次中文覆盖报告' })));
  content.append(node('p', { class: 'data-note', text: '卡组保存在当前浏览器中。清除站点数据或更换浏览器前，请通过「我的卡组」导出完整 JSON 备份。' }));
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const focusable = $$('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]', container).filter((item) => item.getClientRects().length);
  if (!focusable.length) { event.preventDefault(); container.focus(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
}

function wireEvents() {
  filterUI = initSearchFilters({ onChange: () => { synchronizeQuery(); clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); } });
  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault(); runSearch();
    if (window.matchMedia('(max-width: 700px)').matches) $('#search-input').blur();
  });
  $('#search-input').addEventListener('input', () => { acceptQueryEdit(); clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
  $('#sort-select').addEventListener('change', () => { try { const sort = $('#sort-select').value; $('#search-input').value = [extractSearchOptions($('#search-input').value).query, sort === 'name' ? '' : SORT_QUERIES[sort]].filter(Boolean).join(' '); runSearch(); } catch (error) { notify(error.message, 'error'); } });
  $('#load-more').addEventListener('click', appendResults);
  $('#filter-reset').addEventListener('click', resetFilters);
  $('#filter-toggle').addEventListener('click', openFilters);
  $('#filter-close').addEventListener('click', closeFilters);
  $('#filter-results').addEventListener('click', closeFilters);
  $('#filter-scrim').addEventListener('click', closeFilters);
  $('#advanced-open').addEventListener('click', showAdvancedFilters);
  $$('[data-query]').forEach((button) => button.addEventListener('click', () => setQuery(button.dataset.query)));
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('.brand').addEventListener('click', (event) => { event.preventDefault(); deckUI?.showLibrary(); switchView('decks'); });
  $('.skip-link').addEventListener('click', (event) => { event.preventDefault(); switchView('catalog'); $('#search-input').focus(); });
  $('#catalog-target-toggle').addEventListener('click', () => { const picker = $('#catalog-target-picker'); picker.hidden = !picker.hidden; $('#catalog-target-toggle').setAttribute('aria-expanded', String(!picker.hidden)); if (!picker.hidden) $('#catalog-target-select').focus(); });
  $('#catalog-target-select').addEventListener('change', event => { catalogTargetId = event.target.value || null; catalogScopeEnabled = true; refreshCatalogTarget(); runSearch(); });
  $('#catalog-scope-filter').addEventListener('change', event => { catalogScopeEnabled = event.target.checked; synchronizeQuery(); runSearch(); });
  $('#catalog-return-deck').addEventListener('click', async () => { const id = catalogTargetId; switchView('decks'); if (id) await deckUI.openDeck(id); });
  $('#view-grid').addEventListener('click', () => setResultView('grid'));
  $('#view-list').addEventListener('click', () => setResultView('list'));
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-scrim').addEventListener('click', closeDetail);
  $('#help-open').addEventListener('click', () => $('#help-dialog').showModal());
  $('#data-info-open').addEventListener('click', () => $('#data-dialog').showModal());
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
  $$('.app-dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { const box = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close(); }));
  document.addEventListener('keydown', (event) => {
    if ($('.deck-modal-overlay')) return;
    const openNativeDialog = $('dialog[open]');
    if (openNativeDialog) return;
    if (detailCard) { if (event.key === 'Escape') { event.preventDefault(); closeDetail(); } else trapFocus(event, $('#card-detail')); return; }
    if ($('#catalog-view').classList.contains('filters-mobile-open')) { if (event.key === 'Escape') { event.preventDefault(); closeFilters(); } else trapFocus(event, $('#filters')); return; }
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (event.key === '/' && !editing && currentView === 'catalog' && !event.ctrlKey && !event.metaKey) { event.preventDefault(); $('#search-input').focus(); }
  });
  const mq = window.matchMedia('(max-width: 700px)');
  const updateMobile = () => { closeFilters(); $('#filter-toggle').setAttribute('aria-expanded', String(!mq.matches && !$('#catalog-view').classList.contains('filters-collapsed'))); };
  mq.addEventListener('change', updateMobile);
  if (mq.matches) $('#filter-toggle').setAttribute('aria-expanded', 'false');
}

function setResultView(view) {
  resultView = view;
  $('#results').classList.toggle('is-list', view === 'list');
  for (const mode of ['grid', 'list']) { $('#view-' + mode).classList.toggle('active', view === mode); $('#view-' + mode).setAttribute('aria-pressed', String(view === mode)); }
}

function ensureCatalog() {
  if (manifest) return Promise.resolve(true);
  if (catalogPromise) return catalogPromise;
  loading = true;
  catalogPromise = (async () => {
  try {
    const catalog = await loadCatalog({ onProgress: (progress) => {
      const label = typeof progress === 'string' ? progress : progress?.message || progress?.label || (progress?.phase === 'cards' ? '已载入 ' + fmt(progress.cardsLoaded) + ' 张卡牌 · 数据分片 ' + progress.loaded + ' / ' + progress.total : '正在读取卡库清单…');
      const loadingMessage = $('#loading-message');
      if (loadingMessage && hasCatalogSearchIntent()) loadingMessage.textContent = label;
    } });
    allCards = catalog.cards;
    manifest = catalog.manifest;
    knownSetCodes = new Set(allCards.flatMap(card => (card.versions || []).map(version => version.set)).filter(Boolean));
    filterUI.setCatalog(allCards);
    loading = false;
    $('#results').setAttribute('aria-busy', 'false');
    renderDataStatus();
    initializeDeckWorkspace();
    return true;
  } catch (error) {
    loading = false;
    $('#results').setAttribute('aria-busy', 'false');
    const latestQuery = $('#search-input').value.trim();
    const latestVisual = filterUI.getSearch();
    if (currentView === 'catalog' && hasCatalogSearchIntent() && !latestVisual.error && !validateSearch(latestQuery, { commanderOnly: latestVisual.filters.commanderOnly })) {
      $('#results-count').textContent = '卡库暂时不可用';
      $('#data-status-text').textContent = '卡库载入失败 · 已保存的卡组数据仍保留在当前浏览器';
      setResultState({ title: '卡库还没有准备好', message: error.message || '请检查网络后重试。', kind: 'info', action: { label: '重试搜索', run: runSearch } });
    } else if (!hasCatalogSearchIntent()) showIdleCatalog();
    if (!deckUI) $('#deck-view').replaceChildren(node('div', { class: 'result-state' }, [icon('info'), node('h2', { text: '需要先完成卡库加载' }), node('p', { text: '卡库不可用时无法匹配卡牌。已有的本地卡组数据不会被修改。' }), node('button', { class: 'button', text: '重试加载', onClick: () => switchView('decks') })]));
    console.error('Catalog initialization failed', error);
    return false;
  }
  })().finally(() => { loading = false; catalogPromise = null; });
  return catalogPromise;
}

wireEvents();
showIdleCatalog();
initializeDeckWorkspace();
switchView('decks');
