import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export const POSTER_LIMIT = 8 * 1024 * 1024;
export async function readLimitedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('图片为空');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('图片过大'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export function validatePosterPNG(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > POSTER_LIMIT || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12, 16).toString() !== 'IHDR'
      || bytes.readUInt32BE(16) !== 1440 || bytes.readUInt32BE(20) < 1000 || bytes.readUInt32BE(20) > 8192) throw new Error('PNG 图片格式或尺寸无效');
  let position = 8, data = false, end = false;
  while (position + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(position), type = bytes.subarray(position + 4, position + 8).toString();
    if (position + length + 12 > bytes.length) throw new Error('PNG 图片不完整');
    if (type === 'IDAT') data = true;
    position += length + 12;
    if (type === 'IEND') { end = length === 0 && position === bytes.length; break; }
  }
  if (!data || !end) throw new Error('PNG 图片不完整');
}
export function createPosterStore(directory, { fetcher = fetch } = {}) {
  const root = resolve(directory), pending = new Map();
  const path = token => { if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new Error('分享链接无效'); return resolve(root, token + '.png'); };
  const read = async file => { try { return await readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  async function atomicSave(file, bytes) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return {
    async save(token, bytes) { validatePosterPNG(bytes); await atomicSave(path(token), bytes); },
    async read(token) { return read(path(token)); },
    async remove(token) { await unlink(path(token)).catch(error => { if (error.code !== 'ENOENT') throw error; }); },
    async cardImage(source, kind) {
      const url = new URL(source);
      if (url.protocol !== 'https:' || url.hostname !== 'cards.scryfall.io' || url.port || url.username || url.password
          || !/^\/(small|normal|large|png|art_crop|border_crop)\/(front|back)\/[a-f0-9]\/[a-f0-9]\/[a-f0-9-]+\.(jpg|png)$/i.test(url.pathname)) throw new Error('卡图来源不受支持');
      if (kind === 'art') url.pathname = url.pathname.replace(/^\/[^/]+\//, '/art_crop/').replace(/\.png$/, '.jpg');
      const file = resolve(root, 'art-' + createHash('sha256').update(url.href).digest('hex') + '.bin');
      const cached = await read(file); if (cached) return cached;
      if (!pending.has(file)) pending.set(file, (async () => {
        const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Tieyou-Deck-Poster/1.0', Accept: 'image/jpeg,image/png' } });
        if (!response.ok) throw new Error('卡图暂时无法载入');
        const bytes = await readLimitedBody(response, 2 * 1024 * 1024);
        if (!(bytes[0] === 0xff && bytes[1] === 0xd8) && bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('卡图格式无效');
        await atomicSave(file, bytes); return bytes;
      })().finally(() => pending.delete(file)));
      return pending.get(file);
    },
  };
}
