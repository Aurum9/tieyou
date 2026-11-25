import assert from 'node:assert/strict';
import test from 'node:test';
import { saveNativeImage, canSaveNativeImage } from '../web/lib/native-image-save.js';

function environment(t) {
  const names = ['window', 'FileReader', 'TieyouImages'], previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  t.after(() => names.forEach((name, index) => previous[index] ? Object.defineProperty(globalThis, name, previous[index]) : delete globalThis[name]));
  globalThis.window = new EventTarget();
  globalThis.FileReader = class {
    abort() { this.aborted = true; }
    async readAsDataURL(blob) {
      this.result = 'data:image/png;base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64');
      if (!this.aborted) this.onload();
    }
  };
}
test('native save sends local PNG bytes and the filename and waits for its own native callback', async t => {
  environment(t);
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex'); let received;
  globalThis.TieyouImages = { save(requestId, filename, encoded) {
    received = { requestId, filename, encoded };
    window.dispatchEvent(new CustomEvent('tieyou-image-saved', { detail: { requestId: 'another-image', success: false } }));
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('tieyou-image-saved', { detail: { requestId, success: true } })));
  } };
  assert.equal(canSaveNativeImage(), true);
  const result = await saveNativeImage(new Blob([bytes], { type: 'image/png' }), '泰莎的线索.png');
  assert.equal(result.success, true); assert.equal(received.filename, '泰莎的线索.png');
  assert.deepEqual(Buffer.from(received.encoded, 'base64'), bytes);
  assert.match(received.requestId, /^[A-Za-z0-9_-]{1,80}$/);
});
test('native save supports cancellation and missing native capability without any navigation fallback', async t => {
  environment(t); delete globalThis.TieyouImages;
  assert.equal(canSaveNativeImage(), false);
  await assert.rejects(saveNativeImage(new Blob(['png']), 'image.png'), /更新 App/);
  const controller = new AbortController();
  globalThis.TieyouImages = { save() { controller.abort(); } };
  await assert.rejects(saveNativeImage(new Blob(['png']), 'image.png', controller.signal), { name: 'AbortError' });
  globalThis.TieyouImages = { save(requestId) {
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('tieyou-image-saved', { detail: { requestId, success: false, cancelled: true } })));
  } };
  assert.equal((await saveNativeImage(new Blob(['png']), 'image.png')).cancelled, true);
});
