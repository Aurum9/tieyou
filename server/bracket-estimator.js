// Shared server-side proxy for the Commander Spellbook bracket estimate.
const TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE = 256;
const tags = new Set(['E', 'C', 'O', 'P', 'S', 'R', 'B']);
export function normalizeBracketDeck(body) {
  const zones = {};
  for (const zone of ['commanders', 'main']) {
    const rows = body?.[zone];
    if (!Array.isArray(rows) || rows.length > (zone === 'commanders' ? 2 : 100)) throw new Error('牌表分区无效');
    const counts = new Map();
    for (const row of rows) {
      if (typeof row?.card !== 'string' || !row.card.trim() || row.card.length > 300 ||
        !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 100) throw new Error('牌表条目无效');
      const name = row.card.trim();
      counts.set(name, (counts.get(name) || 0) + row.quantity);
    }
    zones[zone] = [...counts].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([card, quantity]) => ({ card, quantity }));
  }
  const count = zones.commanders.reduce((n, row) => n + row.quantity, 0);
  if (count < 1 || count > 2 || zones.main.reduce((n, row) => n + row.quantity, count) > 100) throw new Error('正式牌组须包含一至两张主将且不超过100张牌');
  return zones;
}
export function createBracketEstimator({ fetcher = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map();
  return async function estimate(deck) {
    const key = JSON.stringify(deck);
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetcher('https://backend.commanderspellbook.com/estimate-bracket', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: key, signal: controller.signal,
        });
        if (!response.ok) throw new Error('Commander Spellbook 返回异常');
        const data = await response.json();
        if (!tags.has(data.bracketTag) || !Array.isArray(data.cards) || !Array.isArray(data.combos)) throw new Error('Commander Spellbook 返回格式未识别');
        const value = {
          bracketTag: data.bracketTag,
          cards: data.cards.filter(c => c.banned || c.gameChanger || c.massLandDenial || c.extraTurn).map(c => ({
            name: c.card?.name, quantity: c.quantity, banned: c.banned, gameChanger: c.gameChanger, massLandDenial: c.massLandDenial, extraTurn: c.extraTurn,
          })),
          combos: data.combos.filter(c => c.definitelyTwoCard || c.arguablyTwoCard || c.massLandDenial || c.extraTurn || c.lock || c.skipTurns || c.controlAllOpponents || c.controlSomeOpponents).map(c => ({
            id: c.combo?.id, names: (c.combo?.uses || []).map(u => u.card?.name).filter(Boolean),
            speed: c.speed, relevant: c.relevant, borderlineRelevant: c.borderlineRelevant, definitelyTwoCard: c.definitelyTwoCard, arguablyTwoCard: c.arguablyTwoCard,
            massLandDenial: c.massLandDenial, extraTurn: c.extraTurn, lock: c.lock, skipTurns: c.skipTurns, controlAllOpponents: c.controlAllOpponents, controlSomeOpponents: c.controlSomeOpponents,
          })),
        };
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
        cache.set(key, { value, expires: now() + TTL });
        return value;
      } finally { clearTimeout(timeout); }
    })();
    pending.set(key, work);
    try { return await work; } finally { pending.delete(key); }
  };
}
