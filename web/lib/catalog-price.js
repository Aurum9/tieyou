// ECB reference rates for 2026-11-13: 7.3738 CNY and 1.1052 USD per EUR.
export const CNY_FEN_PER_USD = 667;
export const CNY_PER_USD = CNY_FEN_PER_USD / 100;
export const FIVE_DH_BUDGET = 5;

export function usdToCny(usd) {
  if (!Number.isFinite(usd) || usd < 0) return null;
  const cents = Math.round(usd * 100);
  return Math.round(cents * CNY_FEN_PER_USD / 100) / 100;
}

export function lowestCardPriceInCny(card) {
  if (Number.isFinite(card?.usd)) return usdToCny(card.usd);
  if (!card?.versionsComplete) return null;
  const prices = (card.versions || []).map(version => version.usd).filter(price => Number.isFinite(price) && price >= 0);
  return prices.length ? usdToCny(Math.min(...prices)) : null;
}
