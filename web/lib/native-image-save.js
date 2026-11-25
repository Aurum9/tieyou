export const canSaveNativeImage = () => typeof globalThis.TieyouImages?.save === 'function';

export async function saveNativeImage(blob, filename, signal) {
  if (!canSaveNativeImage()) throw new Error('请更新 App 后再保存图片');
  const encoded = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    const clean = () => signal?.removeEventListener('abort', abort);
    const abort = () => { reader.abort(); clean(); reject(new DOMException('已取消', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    reader.onload = () => { clean(); resolve(String(reader.result).split(',')[1]); };
    reader.onerror = () => { clean(); reject(new Error('图片读取失败，请重试')); };
    reader.readAsDataURL(blob);
  });
  const requestId = 'image_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); window.removeEventListener('tieyou-image-saved', saved); signal?.removeEventListener('abort', abort); };
    const saved = event => { if (event.detail?.requestId !== requestId) return; clean(); resolve(event.detail); };
    const abort = () => { clean(); reject(new DOMException('已取消', 'AbortError')); };
    const timer = setTimeout(() => { clean(); reject(new Error('图片尚未保存，请重试')); }, 10 * 60 * 1000);
    if (signal?.aborted) { abort(); return; }
    window.addEventListener('tieyou-image-saved', saved); signal?.addEventListener('abort', abort, { once: true });
    try { globalThis.TieyouImages.save(requestId, filename, encoded); }
    catch (error) { clean(); reject(error); }
  });
}
