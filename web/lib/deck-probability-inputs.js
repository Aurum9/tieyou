const nameOrder = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

function isLand(face) {
  const [types] = (face.typeLine || '').split(/[—–]/, 1);
  return /\bLand\b/.test(types);
}

export function getDeckProbabilityInputs(deck, cards) {
  const index = new Map(cards.map(card => [card.id, card]));
  const copies = new Map();
  let deckSize = 0;
  for (const entry of deck.entries) {
    if (entry.zone !== 'main') continue;
    deckSize += entry.quantity;
    copies.set(entry.cardId, (copies.get(entry.cardId) || 0) + entry.quantity);
  }

  const targets = [];
  let landCount = 0, modalLandCount = 0, unknownCount = 0;
  for (const [id, count] of copies) {
    const card = index.get(id);
    if (!card) {
      unknownCount += count;
      continue;
    }
    const faces = card.faces?.length ? card.faces : [card];
    if (isLand(faces[0])) landCount += count;
    else if (card.layout === 'modal_dfc' && faces.slice(1).some(isLand)) modalLandCount += count;

    const name = card.zhName || card.name || id;
    const aliases = new Set([
      card.name, ...(card.aliases || []),
      ...faces.flatMap(face => [face.name, face.zhName]),
    ].filter(Boolean));
    aliases.delete(name);
    targets.push({ id, name, aliases: [...aliases], count });
  }
  targets.sort((a, b) => nameOrder.compare(a.name, b.name) || a.id.localeCompare(b.id));
  return { deckSize, landCount, modalLandCount, unknownCount, targets };
}
