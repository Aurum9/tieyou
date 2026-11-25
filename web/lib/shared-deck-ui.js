import { groupDeckEntries } from './deck-editor-groups.js';
import { applyDeckCardColor, createDeckCardImage } from './deck-editor-views.js';
import { manaCost } from './mana-symbols.js';
import { exportDeckText } from './decks.js';

const el = (tag, className = '', text = '') => {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
};
const button = (text, click, className = 'button') => {
  const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', click); return node;
};

export async function showSharedDeck({ container, token, catalog, onInspect, onBack, notify, signal }) {
  container.replaceChildren(el('p', 'deck-muted', '正在载入分享卡组…'));
  try {
    const response = await fetch('/api/shared-decks/' + encodeURIComponent(token), { credentials: 'omit', cache: 'no-store', signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || '分享暂时无法打开');
    const deck = result.deck;
    const cards = await catalog.getCards(deck.entries.map(entry => entry.cardId), { versions: deck.entries.map(entry => ({ cardId: entry.cardId, versionId: entry.versionId })), allowMissing: true, signal });
    signal?.throwIfAborted();
    const index = new Map(cards.map(card => [card.id, card]));
    let view = 'cards';
    const heading = el('header', 'shared-deck-heading');
    const title = el('div'); title.append(el('p', 'deck-eyebrow', '卡组分享'), el('h1', '', deck.name));
    if (deck.description) title.append(el('p', 'shared-deck-description', deck.description));
    const total = deck.entries.reduce((sum, entry) => sum + entry.quantity, 0);
    title.append(el('p', 'deck-muted', total + ' 张 · 更新于 ' + new Date(deck.updatedAt).toLocaleDateString('zh-CN')));
    const actions = el('div', 'deck-actions');
    actions.append(button('我的卡组', onBack), button('导出牌表', () => {
      try {
        const data = exportDeckText(deck, cards), url = URL.createObjectURL(new Blob([data], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url; link.download = deck.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { notify(error.message, 'error'); }
    }));
    heading.append(title, actions);
    const switcher = el('div', 'deck-editor-views'); switcher.setAttribute('aria-label', '分享牌表视图');
    const list = el('div', 'shared-deck-list');
    function render() {
      list.replaceChildren(); switcher.replaceChildren();
      for (const [value, label] of [['cards', '卡图'], ['text', '文本']]) {
        const item = button(label, () => { view = value; render(); }, 'deck-editor-view-button' + (view === value ? ' active' : ''));
        item.setAttribute('aria-pressed', String(view === value)); switcher.append(item);
      }
      for (const zone of ['commander', 'main']) {
        const entries = deck.entries.filter(entry => entry.zone === zone);
        if (!entries.length) continue;
        const section = el('section', 'shared-deck-zone');
        section.append(el('h2', '', (zone === 'commander' ? '统帅' : '主牌') + ' · ' + entries.reduce((sum, entry) => sum + entry.quantity, 0)));
        const groups = zone === 'commander' ? [{ label: '', entries }] : groupDeckEntries(entries, index, 'type');
        for (const group of groups) {
          if (group.label) section.append(el('h3', 'deck-group-title', group.label + ' · ' + group.entries.reduce((sum, entry) => sum + entry.quantity, 0)));
          const grid = el('div', 'shared-deck-entries is-' + view);
          for (const entry of group.entries) {
            const card = index.get(entry.cardId), version = card?.versions?.find(item => item.id === entry.versionId);
            const name = card?.zhName || card?.name || '卡牌资料暂缺';
            const item = el('article', 'shared-deck-card'); applyDeckCardColor(item, card);
            const inspect = () => { if (card) onInspect(card, version); };
            if (view === 'cards') {
              const art = createDeckCardImage({ card, version, name, onInspect: inspect });
              const image = art.querySelector('img');
              if (image && !(image.complete && image.naturalWidth)) {
                art.classList.add('shared-image-pending');
                const ready = () => art.classList.remove('shared-image-pending');
                image.addEventListener('load', ready, { once: true });
                image.addEventListener('error', ready, { once: true });
              }
              item.append(art);
              if (entry.quantity > 1) item.append(el('span', 'shared-deck-quantity deck-entry-quantity-badge', '×' + entry.quantity));
            } else {
              item.append(el('span', 'shared-deck-text-quantity', String(entry.quantity)), button(name, inspect, 'deck-card-link'), manaCost(card?.manaCost || ''));
            }
            grid.append(item);
          }
          section.append(grid);
        }
        list.append(section);
      }
      if (!deck.entries.length) list.append(el('p', 'deck-muted', '这套卡组还没有卡牌。'));
    }
    render(); container.replaceChildren(heading, switcher, list);
    document.title = deck.name + ' · 铁有卡组分享';
  } catch (error) {
    if (signal?.aborted) return;
    const retry = button('重试', () => showSharedDeck({ container, token, catalog, onInspect, onBack, notify, signal }));
    container.replaceChildren(el('h1', '', '分享暂时无法打开'), el('p', 'deck-muted', error.message || '请检查网络后重试'), retry, button('我的卡组', onBack));
  }
}
