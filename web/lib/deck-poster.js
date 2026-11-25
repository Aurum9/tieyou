import qrcode from './vendor/qrcode-generator.js';
import { posterData, flowPosterRows } from './deck-poster-model.js';

const WIDTH = 1440;
const checkAbort = signal => { if (signal?.aborted) throw signal.reason || new DOMException('已取消', 'AbortError'); }; 
const FONT = '"Microsoft YaHei", "PingFang SC", sans-serif';
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const rect = (x, y, width, height, fill, radius = 0) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`;
const image = (src, x, y, width, height, mode = 'meet') => `<image href="${escape(src)}" x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid ${mode}"/>`;
const text = (value, x, y, size, color = '#f1f0e7', weight = 400, anchor = 'start') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
const line = (x, y, right, color = '#d8c19338') => `<path d="M${x} ${y}H${right}" stroke="${color}"/>`;

function qrCode(url, x, y, size) {
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  const count = qr.getModuleCount(), unit = size / (count + 8);
  let path = '';
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
  return rect(x, y, size, size, '#fff', 12) + `<path d="${path}" transform="translate(${x} ${y}) scale(${unit})" fill="#152f27" shape-rendering="crispEdges"/>`;
}

export function buildDeckPosterSVG({ deck, cards, assets = [], shareURL }) {
  const url = new URL(shareURL);
  if (!['http:', 'https:'].includes(url.protocol) || !/^\/s\/[A-Za-z0-9_-]{32}$/.test(url.pathname)) throw new Error('卡组分享链接无效');
  const data = posterData(deck, cards);
  const context = document.createElement('canvas').getContext('2d');
  const measure = (value, size, weight = 400) => { context.font = `${weight} ${size}px ${FONT}`; return context.measureText(value).width; };
  const wrap = (value, width, size, weight = 400) => {
    const result = [];
    for (const paragraph of String(value).split(/\r?\n/)) {
      let current = '';
      for (const char of paragraph) {
        if (current && measure(current + char, size, weight) > width) { result.push(current); current = ''; }
        current += char;
      }
      result.push(current);
    }
    return result;
  };
  const commanders = data.commanders.slice(0, 2), titleWidth = commanders.length > 1 ? 850 : 1000;
  const titleSize = Math.max(40, Math.min(80, 80 * titleWidth / Math.max(1, measure(data.title, 80, 700))));
  const titleLines = wrap(data.title, titleWidth, titleSize, 700);
  let cursor = 70 + titleSize, header = '';
  for (const value of titleLines) { header += text(value, 56, cursor, titleSize, '#fff5da', 700); cursor += titleSize * 1.2; }
  cursor -= titleSize * 1.2;
  if (commanders.length) {
    cursor += 68;
    for (const value of wrap(commanders.map(row => row.name).join(' / '), titleWidth, 32)) { header += text(value, 60, cursor, 32, '#ded7bd', 500); cursor += 43; }
  }
  if (data.description) {
    cursor += commanders.length ? 22 : 60;
    for (const value of wrap(data.description, titleWidth, 28)) { header += text(value, 60, cursor, 28, '#bdcab7'); cursor += 42; }
  }
  const cardWidth = commanders.length > 1 ? 202 : 248, cardHeight = cardWidth * 680 / 488;
  commanders.forEach((row, index) => {
    const x = commanders.length > 1 ? 966 + index * 216 : 1136;
    if (assets[index]?.card) header += image(assets[index].card, x, 48, cardWidth, cardHeight);
  });
  const top = Math.ceil(Math.max(cursor + 32, commanders.length ? 48 + cardHeight + 48 : 230));
  let height = Math.max(1920, Math.ceil((top + 400) / 480) * 480), step, columns;
  while (height <= 8192 && !columns) {
    for (step = 46; step >= 36; step--) {
      columns = flowPosterRows(data.rows, [Math.floor((height - 50 - top) / step), Math.floor((height - 50 - top) / step), Math.floor((height - 344 - top) / step)]);
      if (columns) break;
    }
    if (!columns) height += 480;
  }
  if (!columns || top > 7000) throw new Error('牌表或备注过长，无法生成图片');
  const defs = `<linearGradient id="poster-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#08251f" stop-opacity=".62"/><stop offset=".36" stop-color="#102c25" stop-opacity=".88"/><stop offset="1" stop-color="#0c241e" stop-opacity=".99"/></linearGradient>`;
  let body = rect(0, 0, WIDTH, height, '#0d2922');
  if (assets[0]?.art) body += image(assets[0].art, 0, 0, WIDTH, Math.min(height, top + 800), 'slice');
  body += rect(0, 0, WIDTH, height, 'url(#poster-shade)') + header + line(56, top - 22, 1384, '#c0ac7d55');
  const width = (1328 - 68) / 3, fontSize = Math.min(28, step - 11);
  columns.forEach((rows, column) => {
    const left = 56 + column * (width + 34);
    rows.forEach((row, index) => {
      const y = top + index * step;
      if (row.kind === 'header') body += line(left, y + step - 6, left + width) + text(row.name + (row.continued ? ' · 续' : ''), left + 3, y + step - 16, 24, '#d9c18d', 700);
      else {
        const size = Math.min(fontSize, fontSize * (width - 39) / Math.max(1, measure(row.name, fontSize)));
        body += text(row.quantity, left + 13, y + step - 12, 24, '#b8c8af', 500, 'middle') + text(row.name, left + 37, y + step - 12, size);
      }
    });
  });
  body += qrCode(shareURL, 1120, height - 320, 264);
  return { width: WIDTH, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}"><defs>${defs}</defs><g font-family="${escape(FONT)}">${body}</g></svg>` };
}

function decodeImage(blob, signal) {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const url = URL.createObjectURL(blob), image = new Image();
    const clean = () => { URL.revokeObjectURL(url); signal?.removeEventListener('abort', abort); };
    const abort = () => { image.src = ''; clean(); reject(signal.reason); };
    image.onload = () => { clean(); resolve(image); };
    image.onerror = () => { clean(); reject(new Error('图片解码失败，请重试')); };
    signal?.addEventListener('abort', abort, { once: true }); image.src = url;
  });
}
export async function rasterizeDeckPoster(poster, signal) {
  const image = await decodeImage(new Blob([poster.svg], { type: 'image/svg+xml;charset=utf-8' }), signal);
  checkAbort(signal);
  const canvas = document.createElement('canvas'); canvas.width = poster.width; canvas.height = poster.height;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片导出失败，请重试')), 'image/png'));
}

export async function commanderPosterAssets({ deckId, entry, signal }) {
  const card = entry.card, version = card.versions?.find(item => item.id === entry.versionId);
  const source = version?.faceImages?.[0] || version?.image || card.faces?.[0]?.image || card.image;
  const load = async kind => {
    const direct = source ? new URL(source) : null;
    if (direct && kind === 'art' && direct.hostname === 'cards.scryfall.io') direct.pathname = direct.pathname.replace(/^\/[^/]+\//, '/art_crop/').replace(/\.png$/, '.jpg');
    const controller = new AbortController(), abort = () => controller.abort();
    checkAbort(signal); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 12000);
    const attempts = [fetch(`/api/deck-shares/${encodeURIComponent(deckId)}/art?card=${encodeURIComponent(entry.cardId)}&kind=${kind}`, { credentials: 'same-origin', signal: controller.signal }).then(response => { if (!response.ok) throw new Error('卡图未载入'); return response.blob(); })];
    if (direct && direct.protocol === 'https:') attempts.push(fetch(direct, { mode: 'cors', credentials: 'omit', signal: controller.signal }).then(response => { if (!response.ok) throw new Error('卡图未载入'); return response.blob(); }));
    try { return await Promise.any(attempts); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  };
  const frontBlob = await load('card').catch(() => { checkAbort(signal); throw new Error('主将卡图未载入，请重试'); });
  const front = await decodeImage(frontBlob, signal), canvas = document.createElement('canvas');
  canvas.width = Math.min(960, front.naturalWidth); canvas.height = Math.round(canvas.width * front.naturalHeight / front.naturalWidth);
  canvas.getContext('2d').drawImage(front, 0, 0, canvas.width, canvas.height);
  const cardData = canvas.toDataURL('image/jpeg', .92);
  let art;
  try {
    const artImage = await decodeImage(await load('art'), signal);
    const crop = document.createElement('canvas'); crop.width = Math.min(1440, artImage.naturalWidth); crop.height = Math.round(crop.width * artImage.naturalHeight / artImage.naturalWidth);
    crop.getContext('2d').drawImage(artImage, 0, 0, crop.width, crop.height); art = crop.toDataURL('image/jpeg', .9);
  } catch {
    checkAbort(signal);
    const crop = document.createElement('canvas'); crop.width = 840; crop.height = 620;
    crop.getContext('2d').drawImage(front, front.naturalWidth * .08, front.naturalHeight * .12, front.naturalWidth * .84, front.naturalHeight * .38, 0, 0, 840, 620);
    art = crop.toDataURL('image/jpeg', .9);
  }
  return { card: cardData, art };
}
