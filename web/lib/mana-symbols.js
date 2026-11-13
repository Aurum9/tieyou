import { MANA_SYMBOL_FILES } from '../assets/mana/symbol-files.js';

const assetDirectory = new URL('../assets/mana/', import.meta.url);
const symbolAliases = { '1/2': '½', INFINITY: '∞' };

export function manaSymbol(symbol) {
  const code = String(symbol).trim().toUpperCase();
  const key = symbolAliases[code] || code;
  const label = `{${code}}`;
  if (!Object.hasOwn(MANA_SYMBOL_FILES, key)) return document.createTextNode(label);
  const image = document.createElement('img');
  image.className = 'mana-symbol';
  image.alt = label;
  image.title = label;
  image.src = new URL(MANA_SYMBOL_FILES[key], assetDirectory).href;
  image.draggable = false;
  return image;
}

export function manaCost(value) {
  const cost = document.createElement('span');
  cost.className = 'mana-symbols';
  cost.setAttribute('aria-label', value || '无法术力费用');
  for (const [, symbol] of String(value || '').matchAll(/\{([^{}]+)\}/g)) cost.append(manaSymbol(symbol));
  return cost;
}

export function appendManaText(element, value) {
  const text = String(value || '');
  let start = 0;
  for (const match of text.matchAll(/\{([^{}]+)\}/g)) {
    if (match.index > start) element.append(document.createTextNode(text.slice(start, match.index)));
    element.append(manaSymbol(match[1]));
    start = match.index + match[0].length;
  }
  if (start < text.length) element.append(document.createTextNode(text.slice(start)));
  return element;
}
