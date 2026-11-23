import { TYPE_NAMES, SUPERTYPE_NAMES, collectSubtypes, describeSubtypes } from './type-vocabulary.js';

export function playtestTypeOptions(cards) {
  const subtypes = new Map();
  for (const card of cards) for (const face of card.faces?.length ? card.faces : [card]) collectSubtypes(subtypes, face);
  return [
    ...Object.entries(TYPE_NAMES).map(([value, label]) => ({ value, label, detail: '类别' })),
    ...Object.entries(SUPERTYPE_NAMES).map(([value, label]) => ({ value, label, detail: '超类别' })),
    ...describeSubtypes(subtypes),
  ];
}

export function matchesPlaytestType(piece, card, filter, options = []) {
  if (!filter || filter === 'all') return true;
  const face = card?.faces?.[piece.inverted && card.layout === 'flip' ? 1 : piece.face] || card || piece;
  const [prefix, suffix = ''] = String(face.typeLine || '').split(/\s*[—–～~]\s*/);
  const terms = [...prefix.split(/\s+/), ...(suffix.match(/Time Lord|[^\s／/]+/g) || [])].map(value => value.toLowerCase());
  let chinesePrefix = prefix;
  for (const [value, label] of Object.entries({ ...TYPE_NAMES, ...SUPERTYPE_NAMES }).sort((a, b) => b[1].length - a[1].length)) {
    if (chinesePrefix.includes(label)) { terms.push(value.toLowerCase()); chinesePrefix = chinesePrefix.replaceAll(label, ''); }
  }
  if (filter === 'nonland') return !terms.includes('land');
  const query = filter.trim().toLowerCase();
  const type = options.find(item => [item.value, item.label, ...(item.aliases || [])].some(value => value.toLowerCase() === query));
  return terms.includes((type?.value || query).toLowerCase());
}
