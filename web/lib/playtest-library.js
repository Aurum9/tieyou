import { normalizeText } from './search.js';

function el(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(text, onClick) {
  const control = el('button', 'button button-quiet', text);
  control.type = 'button';
  if (onClick) control.addEventListener('click', onClick);
  return control;
}

function cardList(className, scrollKey) {
  const list = el('div', className);
  list.setAttribute('data-hand-scroll', '');
  list.setAttribute('data-scroll-key', scrollKey);
  return list;
}

function libraryMenu({ ids, showTop, onShowTop, onView, onShuffle, onPeek }) {
  const panel = el('div', 'pt-library-menu');
  const checkbox = el('input');
  checkbox.type = 'checkbox';
  checkbox.checked = showTop;
  checkbox.addEventListener('change', () => onShowTop(checkbox.checked));
  const label = el('label', 'pt-check');
  label.append(checkbox, el('span', '', '持续显示牌库顶'));

  const actions = el('div', 'pt-menu-actions');
  actions.append(button('查看所有牌', () => onView('all')), button('搜寻卡牌', () => onView('search')));
  if (onShuffle) actions.append(button('洗牌', onShuffle));

  const form = el('form', 'pt-library-peek-form');
  const count = el('input', 'pt-input');
  count.type = 'number';
  count.value = ids.length ? '1' : '';
  count.min = '1';
  count.max = String(ids.length);
  count.step = '1';
  count.required = true;
  count.disabled = !ids.length;
  count.setAttribute('aria-label', '查看前几张牌');
  const countLabel = el('label', 'pt-field');
  countLabel.append(el('span', '', '查看前几张牌'), count);
  const peek = button('查看');
  peek.type = 'submit';
  peek.disabled = count.disabled;
  form.append(countLabel, peek);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const requested = Number(count.value);
    if (Number.isSafeInteger(requested) && requested >= 1 && requested <= ids.length) onPeek(requested);
  });

  panel.append(label, actions, form);
  return panel;
}

function peekShelf({ ids, bottomId, cardTile, cleanupList, onClose }) {
  const panel = el('section', 'pt-library-peek');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', '查看牌库顶');
  const heading = el('header', 'pt-dialog-heading');
  heading.append(el('h2', '', `牌库顶 · ${ids.length} 张`), button('关闭', onClose));
  const list = cardList('pt-zone-list pt-peek-list', 'library-peek');
  for (const id of ids) {
    const tile = cardTile(id, { cleanupList, horizontal: true });
    tile.setAttribute('data-drop-zone', 'library-reorder');
    list.append(tile);
  }
  if (!ids.length) list.append(el('p', 'pt-empty', '0 张'));
  const bottom = el('section', 'pt-peek-bottom');
  bottom.setAttribute('data-drop-zone', 'library-bottom');
  bottom.setAttribute('aria-label', '牌库底');
  bottom.append(el('h3', '', '牌库底'));
  bottom.append(bottomId ? cardTile(bottomId, { cleanupList, compact: true }) : el('div', 'pt-pile-empty'));
  const body = el('div', 'pt-peek-body');
  body.setAttribute('data-drop-zone', 'library-peek');
  body.append(list, bottom);
  panel.append(heading, body);
  return panel;
}

function normalizePrinting(value) {
  return normalizeText(value.replace(/^\(([^)]+)\)\s*/, '$1 ').replace(/\s*[:/#]\s*/g, ' '));
}

function matchesCard(card, query, printingQuery) {
  if (typeof card === 'string') return normalizeText(card).includes(query);
  if (!card) return false;
  const { name, zhName, printedName, aliases = [], faces = [], set, setName, collectorNumber } = card;
  const names = [name, zhName, printedName, ...aliases, ...faces.flatMap(face => [face.name, face.zhName])];
  if (names.some(value => normalizeText(value).includes(query))) return true;
  if (!printingQuery) return false;
  const number = normalizeText(collectorNumber);
  if (number.includes(printingQuery)) return true;
  return [set, setName].map(normalizeText).filter(Boolean).some(series =>
    normalizePrinting(`${series} ${number}`).includes(printingQuery));
}

function libraryCards({ mode, ids, query, cardInfo, cardTile, cleanupList, onQueryChange }) {
  const panel = el('div', 'pt-library-panel');
  const list = cardList('pt-zone-list', 'overlay-library');
  const tileCleanups = [];
  const disposeTiles = () => { for (const cleanup of tileCleanups.splice(0)) cleanup(); };
  cleanupList.push(disposeTiles);
  const update = value => {
    const search = normalizeText(value);
    const printing = normalizePrinting(search);
    const visible = search ? ids.filter(id => matchesCard(cardInfo(id), search, printing)) : ids;
    disposeTiles();
    list.replaceChildren();
    for (const id of visible) list.append(cardTile(id, { cleanupList: tileCleanups, horizontal: true }));
    if (!visible.length) list.append(el('p', 'pt-empty', search ? '无匹配卡牌' : '0 张'));
  };
  if (mode === 'search') {
    const tools = el('div', 'pt-zone-tools');
    const input = el('input', 'pt-input');
    input.type = 'search';
    input.value = query;
    input.placeholder = '牌名、系列或编号';
    input.setAttribute('aria-label', '搜索测试牌库');
    input.setAttribute('data-library-search', '');
    input.addEventListener('input', () => {
      onQueryChange(input.value);
      update(input.value);
    });
    tools.append(input);
    panel.append(tools);
  }
  update(mode === 'search' ? query : '');
  panel.append(list);
  return panel;
}

export function createLibraryPanel({ mode, query = '', showTop = false, ...options }) {
  if (mode === 'menu') return libraryMenu({ ...options, showTop });
  if (mode === 'peek') return peekShelf(options);
  return libraryCards({ ...options, mode, query });
}
