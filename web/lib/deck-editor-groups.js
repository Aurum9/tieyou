const TYPES = [
  ['creature', 'Creature', '生物'], ['land', 'Land', '地'], ['planeswalker', 'Planeswalker', '鹏洛客'],
  ['instant', 'Instant', '瞬间'], ['sorcery', 'Sorcery', '法术'], ['artifact', 'Artifact', '神器'],
  ['enchantment', 'Enchantment', '结界'], ['battle', 'Battle', '战役'],
];
const COLORS = { W: '白', U: '蓝', B: '黑', R: '红', G: '绿' };
const COLOR_ORDER = Object.keys(COLORS);
const COLOR_RANK = new Map([...COLOR_ORDER, 'C'].map((color, index) => [color, index]));
const labelsByName = new Intl.Collator('zh-CN', { numeric: true });

export function getDeckEntryCategory(entry) {
  return entry.categories?.find(label => label.trim())?.trim() ?? null;
}

export function getDeckCategories(deck) {
  const labels = new Set((deck.customCategories || []).map(label => label.trim()).filter(Boolean));
  for (const entry of deck.entries || []) {
    const label = getDeckEntryCategory(entry);
    if (label !== null) labels.add(label);
  }
  return [...labels];
}

function groupForCard(card, groupBy) {
  if (groupBy === 'mana') {
    const value = card?.manaValue;
    return Number.isFinite(value) && value >= 0 ? [value, `法术力值 ${value}`] : ['unknown', '法术力值未知'];
  }
  if (!card) return ['unknown', '当前卡库缺失'];
  if (groupBy === 'color') {
    const colors = COLOR_ORDER.filter(color => card.colors?.includes(color));
    if (!colors.length) return ['C', '无色'];
    const label = colors.map(color => COLORS[color]).join('');
    return [colors.join(''), colors.length === 1 ? `${label}色` : label];
  }
  const types = (card.faces?.[0]?.typeLine || card.typeLine || '').split(/[—–]/, 1)[0].split(/\s+/);
  const match = TYPES.find(([, english]) => types.includes(english));
  return match ? [match[0], match[2]] : ['other', '其他'];
}

function compareColorGroups(a, b) {
  if (a.key.length !== b.key.length) return a.key.length - b.key.length;
  for (const [index, color] of [...a.key].entries()) {
    const difference = COLOR_RANK.get(color) - COLOR_RANK.get(b.key[index]);
    if (difference) return difference;
  }
  return 0;
}

export function groupDeckEntries(entries, cardIndex, groupBy, customCategories = []) {
  const groups = new Map();
  const group = (key, label) => {
    if (!groups.has(key)) groups.set(key, { key, label, entries: [] });
    return groups.get(key);
  };
  if (groupBy === 'category') {
    group(null, '未分类');
    for (const label of getDeckCategories({ customCategories, entries })) group(label, label);
    for (const entry of entries) groups.get(getDeckEntryCategory(entry)).entries.push(entry);
    return [...groups.values()];
  }
  for (const entry of entries) {
    const [key, label] = groupForCard(cardIndex.get(entry.cardId), groupBy);
    group(key, label).entries.push(entry);
  }
  const result = [...groups.values()];
  if (groupBy === 'color') return result.sort(compareColorGroups);
  if (groupBy === 'mana') return result.sort((a, b) => (typeof a.key === 'number' ? a.key : Infinity) - (typeof b.key === 'number' ? b.key : Infinity));
  return result.sort((a, b) => labelsByName.compare(a.label, b.label));
}
