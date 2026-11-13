import { localizedTagSlugs, TAG_NAMES } from './tag-names.js';

/** The current add destination belongs to the active session, not the saved library. */
export function resolveDeckTarget(decks, targetId) {
  if (!targetId || !Array.isArray(decks)) return null;
  return decks.find(deck => deck.id === targetId) || null;
}

const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function deckTagQuery(text) {
  const input = String(text ?? '').normalize('NFKC').trim();
  const match = input.match(/^(?:otag|tag|功能)\s*[:=]\s*(.+)$/i);
  if (match) {
    const value = match[1].replace(/^"(.*)"$/, '$1').trim();
    return value ? `otag:${quote(value)}` : null;
  }
  const slug = input.toLowerCase();
  if (localizedTagSlugs(input) || (slug.includes('-') && Object.hasOwn(TAG_NAMES, slug))) {
    return `otag:${quote(input)}`;
  }
  return null;
}

/** Turn the deck editor's name, printing or tag input into a catalogue query. */
export function catalogQueryFromDeckSearch(text, knownSetCodes = []) {
  const value = String(text ?? '').trim();
  if (!value) return '';
  const tag = deckTagQuery(value);
  if (tag) return `${tag} order:edhrec`;
  const printing = value.match(/^([a-z0-9]+)\s*[:/#\s]\s*(\S+)$/i);
  if (printing && /^[0-9][a-z0-9★*\-]*$/i.test(printing[2])) {
    const code = printing[1].toLowerCase();
    const known = new Set([...knownSetCodes].map(set => String(set).toLowerCase()));
    if (known.has(code)) return `set:${quote(code)} cn:${quote(printing[2])}`;
  }
  return `name:${quote(value)}`;
}

/** An empty selected identity is colorless; no selected commander has no scope. */
export function commanderScopeQuery(identity) {
  if (identity == null) return '';
  const selected = new Set([...identity].map(color => String(color).toLowerCase()));
  const colors = [...'wubrg'].filter(color => selected.has(color)).join('');
  return `ci<=${colors || '无色'}`;
}
