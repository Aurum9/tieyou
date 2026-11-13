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
