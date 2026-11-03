import { loadCatalog } from './lib/catalog.js';
import { parseQuery, searchCards } from './lib/search.js';
import { initDeckUI } from './lib/deck-ui.js';
import { initSearchFilters } from './lib/filter-ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const PAGE_SIZE = 48;
const COLOR_NAMES = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿', C: '无色' };
const MANA_GLYPHS = { W: '☀', U: '◆', B: '●', R: '◆', G: '♣', C: '◇', T: '↷', Q: '↶', E: 'ϟ', S: '❄' };
let allCards = [];
let manifest = null;
let deckUI = null;
let matchedCards = [];
let renderedCount = 0;
let currentView = 'catalog';
let resultView = 'grid';
let detailCard = null;
let detailVersion = null;
let detailLanguage = 'zh';
let previousFocus = null;
let searchTimer = null;
let loading = true;
let mobileFilterFocus = null;
let filterUI = null;

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
  const article = node('article', { class: 'card-tile' });
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
  article.append(image, info);
  return article;
}

function setResultState({ title, message, kind = 'search', action } = {}) {
  const state = $('#result-state');
  state.replaceChildren();
  if (kind === 'loading') state.append(node('div', { class: 'loading-spinner', 'aria-hidden': 'true' }));
  else state.append(icon(kind));
  state.append(node('h2', { text: title }), node('p', { text: message }));
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

function runSearch() {
  if (loading) return;
  clearTimeout(searchTimer);
  const query = $('#search-input').value.trim();
  const visual = filterUI.getSearch();
  const combinedQuery = [query ? '(' + query + ')' : '', visual.query].filter(Boolean).join(' AND ');
  const errorBox = $('#search-error');
  let result;
  try {
    if (query) parseQuery(query);
    result = visual.error ? { cards: [], total: 0, error: { message: visual.error } } : searchCards(allCards, combinedQuery, visual.filters, $('#sort-select').value);
  } catch (error) {
    result = { cards: [], total: 0, error: { message: error.message || '检索出现问题，请修改条件后重试。', rawPosition: error.position } };
  }
  renderActiveFilters();
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

function clearSearch() { $('#search-input').value = ''; resetFilters(); }
function setQuery(query) {
  $('#search-input').value = query;
  $$('dialog[open]').forEach((dialog) => dialog.close());
  switchView('catalog');
  runSearch();
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
  $('#filter-scrim').hidden = true;
  $('#filters').removeAttribute('role');
  $('#filters').removeAttribute('aria-modal');
  document.body.classList.remove('modal-open');
  if (window.matchMedia('(max-width: 700px)').matches) $('#filter-toggle').setAttribute('aria-expanded', 'false');
  mobileFilterFocus?.focus();
  mobileFilterFocus = null;
}

function showAdvancedFilters() {
  filterUI.setMode('advanced');
  if (window.matchMedia('(max-width: 700px)').matches) {
    if (!$('#catalog-view').classList.contains('filters-mobile-open')) openFilters();
  } else {
    $('#catalog-view').classList.remove('filters-collapsed');
    $('#filter-toggle').setAttribute('aria-expanded', 'true');
  }
}

function switchView(view) {
  currentView = view;
  $('#catalog-view').hidden = view !== 'catalog';
  $('#deck-view').hidden = view !== 'decks';
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (view === 'decks') {
    if (deckUI) deckUI.showLibrary();
    else if (loading) $('#deck-view').replaceChildren(node('div', { class: 'result-state' }, [node('div', { class: 'loading-spinner' }), node('h2', { text: '正在准备卡组工作台' }), node('p', { text: '卡库加载完成后即可创建和编辑卡组。' })]));
  }
}

async function addCard(card, version) {
  if (!deckUI) { notify(loading ? '卡库仍在加载，请稍候。' : '卡组工作台暂时不可用，请刷新后重试。', 'error'); return; }
  try {
    await deckUI.addCard(card, version);
  } catch (error) {
    notify(error.message || '卡牌暂时无法加入卡组，请重试。', 'error');
  }
}

function openDetail(card) {
  if (!card) return;
  previousFocus = document.activeElement;
  detailCard = card;
  detailVersion = selectedVersionFor(card);
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
  root.append(node('button', { class: 'button button-primary detail-add', type: 'button', onClick: () => addCard(card, detailVersion || versions[0]) }, [icon('plus'), '选择卡组并加入']));
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
  filterUI = initSearchFilters({ onChange: () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); } });
  $('#search-form').addEventListener('submit', (event) => { event.preventDefault(); runSearch(); });
  $('#search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });
  $('#sort-select').addEventListener('change', runSearch);
  $('#load-more').addEventListener('click', appendResults);
  $('#filter-reset').addEventListener('click', resetFilters);
  $('#filter-toggle').addEventListener('click', openFilters);
  $('#filter-close').addEventListener('click', closeFilters);
  $('#filter-scrim').addEventListener('click', closeFilters);
  $('#advanced-open').addEventListener('click', showAdvancedFilters);
  $$('[data-query]').forEach((button) => button.addEventListener('click', () => setQuery(button.dataset.query)));
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('.brand').addEventListener('click', (event) => { event.preventDefault(); switchView('catalog'); });
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

async function boot() {
  wireEvents();
  try {
    const catalog = await loadCatalog({ onProgress: (progress) => {
      const label = typeof progress === 'string' ? progress : progress?.message || progress?.label || (progress?.phase === 'cards' ? '已载入 ' + fmt(progress.cardsLoaded) + ' 张卡牌 · 数据分片 ' + progress.loaded + ' / ' + progress.total : '正在读取卡库清单…');
      const loadingMessage = $('#loading-message');
      if (loadingMessage) loadingMessage.textContent = label;
    } });
    allCards = catalog.cards;
    manifest = catalog.manifest;
    filterUI.setCatalog(allCards);
    loading = false;
    $('#results').setAttribute('aria-busy', 'false');
    renderDataStatus();
    try {
      deckUI = initDeckUI({ container: $('#deck-view'), cards: allCards, onInspect: openDetail, onNotify: notify });
      if (currentView === 'decks') deckUI.showLibrary();
    } catch (error) {
      $('#deck-view').replaceChildren(node('div', { class: 'result-state' }, [icon('info'), node('h2', { text: '卡组工作台暂时无法载入' }), node('p', { text: error.message || '请刷新后重试。' })]));
      console.error('Deck workspace initialization failed', error);
    }
    runSearch();
  } catch (error) {
    loading = false;
    $('#results').setAttribute('aria-busy', 'false');
    $('#results-count').textContent = '卡库暂时不可用';
    $('#data-status-text').textContent = '卡库载入失败 · 已保存的卡组数据仍保留在当前浏览器';
    setResultState({ title: '卡库还没有准备好', message: error.message || '请检查网络或本地数据文件后重新加载。', kind: 'info', action: { label: '重新加载', run: () => window.location.reload() } });
    $('#deck-view').replaceChildren(node('div', { class: 'result-state' }, [icon('info'), node('h2', { text: '需要先完成卡库加载' }), node('p', { text: '卡库不可用时无法匹配卡牌。已有的本地卡组数据不会被修改。' }), node('button', { class: 'button', text: '重新加载', onClick: () => window.location.reload() })]));
    console.error('Catalog initialization failed', error);
  }
}

boot();
