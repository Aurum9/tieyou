/** Printed values remain strings: zero and variable characteristics are meaningful. */
export function faceCharacteristics(face) {
  const present = value => value !== undefined && value !== null && String(value) !== '';
  const facts = [];
  if (present(face.power) || present(face.toughness)) facts.push(['力量 / 防御力', `${present(face.power) ? face.power : '—'} / ${present(face.toughness) ? face.toughness : '—'}`]);
  for (const [field, label] of [['loyalty', '起始忠诚'], ['defense', '防御值'], ['handModifier', '手牌修正'], ['lifeModifier', '生命修正']]) {
    if (present(face[field])) facts.push([label, String(face[field])]);
  }
  return facts;
}
export function detailDeckEntry(deck, cardId, context) {
  if (!deck) return null;
  if (context) return deck.id === context.deckId ? deck.entries.find(entry => entry.id === context.entryId && entry.cardId === cardId) || null : null;
  return deck.entries.find(entry => entry.cardId === cardId && entry.zone === 'main') || null;
}
