import { CNY_PER_USD, FIVE_DH_BUDGET, lowestCardPriceInCny } from './catalog-price.js';

const colors = new Set(['W', 'U', 'B', 'R', 'G']);

export function applyDeckCardColor(wrapper, card) {
  const actualColors = [...colors].filter(color => card?.colors?.includes(color));
  const [first, second] = actualColors;
  if (actualColors.length === 2) {
    wrapper.setAttribute('data-deck-color', 'dual');
    wrapper.setAttribute('style', `--editor-edge-first:var(--editor-edge-${first});--editor-edge-second:var(--editor-edge-${second})`);
  } else wrapper.setAttribute('data-deck-color', actualColors.length > 2 ? 'M' : first || 'C');
}

export function createDeckCardImage({ card, version, name, onInspect, stackPreview = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'deck-editor-image';
  button.setAttribute('aria-label', name);
  if (card) button.addEventListener('click', () => onInspect(card, version));
  else button.disabled = true;

  const label = document.createElement('span');
  label.className = 'deck-editor-image-label';
  label.textContent = name;
  const source = version?.faceImages?.[0] || version?.image || card?.image || card?.faces?.[0]?.image;
  if (/^https?:\/\//i.test(source || '')) {
    const image = document.createElement('img');
    image.src = source;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.draggable = false;
    image.addEventListener('error', () => {
      image.remove();
      button.classList.add('is-missing-image');
    }, { once: true });
    button.append(image);
    if (stackPreview) {
      const positionPreview = () => {
        const rect = button.getBoundingClientRect();
        const headerBottom = document.querySelector('.app-header')?.getBoundingClientRect().bottom ?? 0;
        const top = Math.max(8, headerBottom + 8);
        const bottom = window.innerHeight - 8;
        const available = Math.max(0, bottom - top);
        const height = Math.min(available, image.getBoundingClientRect().width * 680 / 488);
        const y = Math.max(top, Math.min(rect.top + button.clientTop, bottom - height));
        button.parentElement.style.setProperty('--editor-stack-preview-offset', `${y - rect.top - button.clientTop}px`);
        button.parentElement.style.setProperty('--editor-stack-preview-height', `${available}px`);
      };
      button.addEventListener('pointerenter', event => {
        if (event.pointerType !== 'touch') positionPreview();
      });
      button.addEventListener('focus', positionPreview);
    }
  } else button.classList.add('is-missing-image');
  button.append(label);
  return button;
}

function createDeckPriceIcon(missing) {
  const ns = 'http://www.w3.org/2000/svg';
  const icon = document.createElementNS(ns, 'svg');
  icon.setAttribute('class', 'deck-budget-icon');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', missing ? '无报价' : '超过 5 元预算');
  const circle = document.createElementNS(ns, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '7');
  circle.setAttribute('fill', 'currentColor');
  const mark = document.createElementNS(ns, 'path');
  mark.setAttribute('d', missing ? 'M6 6.1a2 2 0 1 1 3.5 1.3C8.8 8.2 8 8.3 8 9.5m0 2.2h.01' : 'M8 11.8V4.4M5.2 7.3 8 4.4l2.8 2.9');
  mark.setAttribute('stroke', 'white');
  mark.setAttribute('stroke-width', '1.45');
  mark.setAttribute('stroke-linecap', 'round');
  mark.setAttribute('stroke-linejoin', 'round');
  mark.setAttribute('fill', 'none');
  icon.append(circle, mark);
  return icon;
}

export function createDeckPriceBadge(card, { highlight = true } = {}) {
  const price = lowestCardPriceInCny(card);
  const badge = document.createElement('span');
  badge.className = 'deck-budget-price';
  badge.title = price === null ? '卡库无普通版报价' : `所有印刷版本中的最低普通版报价，1 USD ≈ ${CNY_PER_USD} CNY`;
  if (highlight && price === null) {
    badge.classList.add('has-no-deck-price');
    badge.append(createDeckPriceIcon(true));
  } else if (highlight && price > FIVE_DH_BUDGET) {
    if (price >= FIVE_DH_BUDGET * 2) {
      badge.classList.add('is-deck-price-double');
    } else {
      badge.classList.add('is-deck-price-over');
      const overage = (price - FIVE_DH_BUDGET) / FIVE_DH_BUDGET;
      badge.style.setProperty('--deck-price-overage', `${overage * 100}%`);
    }
    badge.append(createDeckPriceIcon(false));
  }
  badge.append(document.createTextNode(price === null ? '无报价' : '¥' + price.toFixed(2)));
  return badge;
}
