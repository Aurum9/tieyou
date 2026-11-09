let catalogRequest;

export function loadTokenCatalog() {
  catalogRequest ??= fetch('/data/playtest-tokens.json').then(async response => {
    if (!response.ok) throw new Error('衍生物牌库加载失败');
    const data = await response.json();
    if (data.version !== 1 || !data.tokens || !data.byCard) throw new Error('衍生物牌库格式无效');
    return data;
  }).catch(error => {
    catalogRequest = undefined;
    throw error;
  });
  return catalogRequest;
}

export function linkedTokens(catalog, cardIds) {
  return [...new Set(cardIds.flatMap(id => catalog.byCard[id] || []))]
    .map(id => catalog.tokens[id]).filter(Boolean);
}

export function tokenLabel(token) {
  const name = token.zhName || token.name;
  return /\bCreature\b/.test(token.typeLine.split('—')[0]) && token.power && token.toughness
    ? `${token.power}/${token.toughness} ${name}` : name;
}
