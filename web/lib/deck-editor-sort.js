import { lowestCardPriceInCny } from './catalog-price.js';

export const DECK_SORT_OPTIONS = [
  ['mana', '法术力值'],
  ['name-zh', '中文名称'],
  ['name-en', '英文名称'],
  ['price', '单卡最低价'],
  ['edhrec', 'EDHREC 热度'],
  ['added', '加入顺序'],
];

const DEFAULT_PREFERENCES = { groupBy: 'type', viewMode: 'text', sortBy: 'mana', sortDirection: 'asc' };
const GROUPS = ['type', 'mana', 'color', 'category'];
const VIEWS = ['text', 'cards', 'stack'];
const SORTS = DECK_SORT_OPTIONS.map(([value]) => value);
const chineseNames = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
const englishNames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function getDeckEditorPreferences(deck) {
  return { ...DEFAULT_PREFERENCES, ...deck.editorPreferences };
}

export function validateDeckEditorPreferences(preferences) {
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('牌表显示设置格式不正确');
  const result = { ...DEFAULT_PREFERENCES, ...preferences };
  if (!GROUPS.includes(result.groupBy) || !VIEWS.includes(result.viewMode) || !SORTS.includes(result.sortBy) ||
      !['asc', 'desc'].includes(result.sortDirection)) throw new Error('牌表显示设置格式不正确');
  return { groupBy: result.groupBy, viewMode: result.viewMode, sortBy: result.sortBy, sortDirection: result.sortDirection };
}

export function defaultSortDirection(sortBy) {
  return ['price', 'added'].includes(sortBy) ? 'desc' : 'asc';
}

export function sortDirectionLabel(sortBy, direction) {
  const labels = {
    mana: ['费用从低到高', '费用从高到低'],
    'name-zh': ['拼音正序', '拼音倒序'],
    'name-en': ['A–Z', 'Z–A'],
    price: ['价格从低到高', '价格从高到低'],
    edhrec: ['热门在前', '冷门在前'],
    added: ['最早加入在前', '最近加入在前'],
  };
  return labels[sortBy][direction === 'asc' ? 0 : 1];
}

function cardName(card, entry, chinese) {
  return (chinese && card?.zhName?.trim()) || card?.name?.trim() || entry.cardId;
}

export function createDeckEntryComparator(deck, cardIndex, preferences = getDeckEditorPreferences(deck)) {
  const positions = new Map(deck.entries.map((entry, index) => [entry.id, index]));
  const numericValues = new Map();
  const { sortBy, sortDirection } = preferences;
  const direction = sortDirection === 'asc' ? 1 : -1;
  if (['mana', 'price', 'edhrec'].includes(sortBy)) {
    for (const entry of deck.entries) {
      const card = cardIndex.get(entry.cardId);
      let value;
      if (sortBy === 'price') value = lowestCardPriceInCny(card);
      else if (sortBy === 'edhrec') value = card?.edhrecRank > 0 ? card.edhrecRank : null;
      else value = card?.manaValue;
      numericValues.set(entry.id, Number.isFinite(value) && value >= 0 ? value : null);
    }
  }
  return (left, right) => {
    const leftCard = cardIndex.get(left.cardId);
    const rightCard = cardIndex.get(right.cardId);
    let comparison = 0;
    if (sortBy === 'name-zh') {
      comparison = chineseNames.compare(cardName(leftCard, left, true), cardName(rightCard, right, true));
    } else if (sortBy === 'name-en') {
      comparison = englishNames.compare(cardName(leftCard, left, false), cardName(rightCard, right, false));
    } else if (sortBy === 'added') {
      comparison = positions.get(left.id) - positions.get(right.id);
    } else {
      const leftValue = numericValues.get(left.id);
      const rightValue = numericValues.get(right.id);
      if (leftValue === null && rightValue !== null) return 1;
      if (rightValue === null && leftValue !== null) return -1;
      if (leftValue !== null && rightValue !== null) comparison = leftValue - rightValue;
    }
    if (comparison) return comparison * direction;
    const byName = chineseNames.compare(cardName(leftCard, left, true), cardName(rightCard, right, true));
    return byName || positions.get(left.id) - positions.get(right.id);
  };
}
