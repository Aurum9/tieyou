import { groupDeckEntries } from './deck-editor-groups.js';

export function posterData(deck, cards) {
  const index = new Map(cards.map(card => [card.id, card]));
  const main = new Map(), commanders = [];
  for (const entry of deck.entries) {
    if (!['main', 'commander'].includes(entry.zone)) continue;
    const card = index.get(entry.cardId);
    if (!card) throw new Error('部分卡牌资料未载入，请重试');
    const row = { ...entry, name: card.zhName || card.name, manaValue: card.manaValue || 0, card };
    if (entry.zone === 'commander') commanders.push(row);
    else if (main.has(entry.cardId)) main.get(entry.cardId).quantity += entry.quantity;
    else main.set(entry.cardId, row);
  }
  if (main.size > 240) throw new Error('牌表超过 240 种单卡，暂时无法生成图片');
  const groups = groupDeckEntries([...main.values()], index, 'type');
  const order = ['creature', 'artifact', 'enchantment', 'instant', 'sorcery', 'planeswalker', 'battle', 'land', 'other'];
  groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  const rows = [];
  for (const group of groups) {
    const heading = { kind: 'header', name: group.label };
    group.entries.sort((a, b) => a.manaValue - b.manaValue || a.name.localeCompare(b.name, 'zh-CN'));
    rows.push(heading, ...group.entries.map(row => ({ ...row, kind: 'card', heading })));
  }
  return { title: deck.name, description: deck.description || '', commanders, rows };
}

/** Flow into three columns, with a shorter final column above the QR square. */
export function flowPosterRows(rows, capacities) {
  let cursor = 0;
  const columns = capacities.map(capacity => {
    const column = [];
    if (rows[cursor]?.kind === 'card') column.push({ ...rows[cursor].heading, continued: true });
    let take = Math.min(Math.max(0, capacity - column.length), rows.length - cursor);
    if (take && rows[cursor + take - 1]?.kind === 'header') take--;
    column.push(...rows.slice(cursor, cursor + take)); cursor += take;
    return column;
  });
  return cursor === rows.length ? columns : null;
}
