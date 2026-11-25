import { normalizeText } from './search.js';
import { visibleTagLabel, loadTagVocabulary, canonicalTagSlug } from './tag-vocabulary.js';
import { linkedTokens, loadTokenCatalog, tokenLabel } from './playtest-token-catalog.js';

export { loadTagVocabulary, loadTokenCatalog };

const sortNames = new Intl.Collator('zh-Hans-CN', { numeric: true });

function addSource(groups, key, entry, summary) {
  const group = groups.get(key) || { ...summary, count: 0, entryIds: [] };
  group.count += entry.quantity;
  group.entryIds.push(entry.id);
  groups.set(key, group);
}

export function analyzeDeckRelated(deck, cards, { tagVocabulary = [], tokenCatalog } = {}) {
  const index = cards instanceof Map ? cards : new Map(cards.map(card => [card.id, card]));
  const tagsByName = new Map(tagVocabulary.map(tag => [normalizeText(tag.slug), tag]));
  for (const tag of tagVocabulary) {
    for (const alias of tag.aliases || []) {
      const key = normalizeText(alias);
      if (key && !tagsByName.has(key)) tagsByName.set(key, tag);
    }
  }
  const tags = new Map(), tokens = new Map();
  for (const entry of deck.entries) {
    if (entry.zone === 'considering') continue;
    const seen = new Set();
    for (const rawTag of index.get(entry.cardId)?.tags || []) {
      const key = normalizeText(typeof rawTag === 'string' ? rawTag : rawTag?.slug || rawTag?.name || rawTag?.id);
      const tag = tagsByName.get(key);
      const slug = canonicalTagSlug(tag?.slug || key);
      const label = visibleTagLabel(slug);
      if (!label || seen.has(slug)) continue;
      seen.add(slug);
      addSource(tags, slug, entry, { slug, label, aliases: tag?.aliases || [] });
    }
    if (tokenCatalog) {
      for (const token of linkedTokens(tokenCatalog, [entry.cardId])) {
        addSource(tokens, token.id, entry, { id: token.id, token, label: tokenLabel(token) });
      }
    }
  }
  const byFrequency = (a, b) => b.count - a.count || sortNames.compare(a.label, b.label);
  return {
    tags: [...tags.values()].sort((a, b) => byFrequency(a, b) || sortNames.compare(a.slug, b.slug)),
    tokens: [...tokens.values()].sort((a, b) => byFrequency(a, b) || sortNames.compare(a.id, b.id)),
  };
}
