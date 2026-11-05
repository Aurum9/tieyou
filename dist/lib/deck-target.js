/** The current add destination belongs to the active session, not the saved library. */
export function resolveDeckTarget(decks, targetId) {
  if (!targetId || !Array.isArray(decks)) return null;
  return decks.find(deck => deck.id === targetId) || null;
}

const quote = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Turn the deck editor's plain name/printing input into a literal catalogue query. */
export function catalogQueryFromDeckSearch(text, knownSetCodes = []) {
  const value = String(text ?? '').trim();
  if (!value) return '';
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
