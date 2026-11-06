const zoneNames = { main: '主牌', commander: '统帅', considering: '候选' };

/** Build once when the library or catalog target changes, then look up by Oracle ID. */
export function buildDeckMembership(decks, targetId = null) {
  const selected = targetId ? decks.filter(deck => deck.id === targetId) : decks;
  const membership = new Map();
  for (const deck of selected) {
    const seen = new Set();
    for (const entry of deck.entries || []) {
      if (!entry.cardId || !Object.hasOwn(zoneNames, entry.zone) || !Number.isInteger(entry.quantity) || entry.quantity < 1) continue;
      let record = membership.get(entry.cardId);
      if (!record) {
        record = { main: 0, commander: 0, considering: 0, total: 0, deckCount: 0, label: '' };
        membership.set(entry.cardId, record);
      }
      record[entry.zone] += entry.quantity;
      record.total += entry.quantity;
      if (!seen.has(entry.cardId)) { record.deckCount++; seen.add(entry.cardId); }
    }
  }
  for (const record of membership.values()) {
    record.label = targetId
      ? `已在${Object.entries(zoneNames).filter(([zone]) => record[zone]).map(([zone, name]) => `${name} ×${record[zone]}`).join(' · ')}`
      : `已在 ${record.deckCount} 套卡组`;
  }
  return membership;
}
