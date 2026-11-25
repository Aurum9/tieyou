import { posterData } from './deck-poster-model.js';
import { buildDeckPosterSVG, rasterizeDeckPoster, commanderPosterAssets } from './deck-poster.js';

export async function showDeckPoster({ dialog, deckId, shareURL, username, loadCards, notify }) {
  let objectURL = null, blob = null;
  const controller = new AbortController();
  const current = dialog('分享图片', { wide: true, onClose: () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); } });
  current.panel.classList.add('deck-poster-dialog');
  const status = document.createElement('p'); status.className = 'deck-muted'; status.setAttribute('role', 'status');
  const preview = document.createElement('img'); preview.className = 'deck-poster-preview'; preview.alt = '卡组分享图片'; preview.hidden = true;
  const actions = document.createElement('div'); actions.className = 'deck-actions';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'button button-primary'; save.textContent = '保存图片'; save.disabled = true;
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = '重试'; retry.hidden = true;
  let filename = '铁有卡组.png';
  async function generate() {
    retry.hidden = true; status.hidden = false; status.className = 'deck-muted'; status.textContent = '正在生成图片…'; save.disabled = true;
    try {
      const token = new URL(shareURL).pathname.split('/').at(-1);
      const response = await fetch('/api/shared-decks/' + encodeURIComponent(token), { cache: 'no-store', credentials: 'omit', signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '分享已关闭，请重新开启');
      const deck = result.deck;
      const cards = await loadCards(deck.entries.map(row => row.cardId), { versions: deck.entries.map(row => ({ cardId: row.cardId, versionId: row.versionId })), signal: controller.signal });
      const data = posterData(deck, cards);
      const assets = await Promise.all(data.commanders.slice(0, 2).map(entry => commanderPosterAssets({ deckId, entry, signal: controller.signal })));
      const poster = buildDeckPosterSVG({ deck, cards, assets, shareURL });
      blob = await rasterizeDeckPoster(poster, controller.signal);
      if (controller.signal.aborted) return;
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = URL.createObjectURL(blob); preview.src = objectURL; preview.hidden = false;
      filename = deck.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) + '.png';
      status.hidden = true; save.disabled = false;
    } catch (error) {
      if (controller.signal.aborted) return;
      status.className = 'deck-form-error'; status.textContent = error.message || '图片暂时无法生成，请重试'; retry.hidden = false;
    }
  }
  retry.addEventListener('click', generate);
  save.addEventListener('click', async () => {
    if (!blob || save.disabled) return;
    if (!globalThis.tieyouAndroid) {
      const link = document.createElement('a'); link.href = objectURL; link.download = filename; link.click(); return;
    }
    save.disabled = true; save.textContent = '正在保存…';
    try {
      const response = await fetch('/api/deck-shares/' + encodeURIComponent(deckId) + '/poster', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'image/png', 'X-Tieyou-Share-Owner': encodeURIComponent(username) }, body: blob, signal: controller.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || '保存失败，请重试');
      if (controller.signal.aborted) return;
      // Existing Android clients already hand HTTPS downloads to the browser.
      location.assign(result.url);
    } catch (error) { if (!controller.signal.aborted) notify(error.message || '保存失败，请重试', 'error'); }
    finally { save.disabled = false; save.textContent = '保存图片'; }
  });
  actions.append(save, retry); current.panel.append(status, preview, actions);
  await generate();
  return current;
}
