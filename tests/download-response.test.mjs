import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadResponse, isPublicDownload } from '../scripts/download-response.mjs';

const path = '/downloads/tieyou-android-0.3.1.apk', bytes = Buffer.from('0123456789'), date = new Date('2026-01-01T12:00:00Z');
const request = (headers = {}, method = 'GET') => new Request('https://sbwsz.cn' + path, { method, headers });
test('downloads return the correct middle, open-ended and suffix bytes with resumable headers', async () => {
  for (const [range, expected, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-100', '89', 'bytes 8-9/10']]) {
    const response = downloadResponse(request({ Range: range }), path, bytes, date);
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), contentRange); assert.equal(response.headers.get('Content-Length'), String(expected.length)); assert.equal(await response.text(), expected);
  }
  const response = downloadResponse(request(), path, bytes, date);
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes'); assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal(response.headers.get('Content-Type'), 'application/vnd.android.package-archive'); assert.equal(await response.text(), '0123456789');
});
test('If-Range avoids appending bytes from a different APK, and matching ETags allow cached downloads', async () => {
  const current = downloadResponse(request(), path, bytes, date), etag = current.headers.get('ETag');
  for (const token of [etag, date.toUTCString()]) {
    const response = downloadResponse(request({ Range: 'bytes=5-', 'If-Range': token }), path, bytes, date);
    assert.equal(response.status, 206); assert.equal(await response.text(), '56789');
  }
  for (const token of ['"old-apk"', 'W/' + etag, 'Thu, 01 Jan 1970 00:00:00 GMT']) {
    const response = downloadResponse(request({ Range: 'bytes=5-', 'If-Range': token }), path, bytes, date);
    assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  }
  assert.equal(downloadResponse(request({ 'If-None-Match': etag }), path, bytes, date).status, 304);
  assert.equal(downloadResponse(request({ 'If-None-Match': 'W/' + etag }), path, bytes, date).status, 304);
  const mutable = downloadResponse(request(), '/downloads/tieyou-android.apk', bytes, date);
  assert.equal(mutable.headers.get('Cache-Control'), 'no-cache');
});
test('unsatisfiable requests return 416; HEAD never sends bytes; only public installation artifacts use this handler', async () => {
  for (const range of ['bytes=10-', 'bytes=5-4', 'bytes=-0', 'bytes=99999999999999999999999-']) {
    const response = downloadResponse(request({ Range: range }), path, bytes, date);
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */10'); assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  const head = downloadResponse(request({ Range: 'bytes=2-5' }, 'HEAD'), path, bytes, date);
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '10'); assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.ok(isPublicDownload(path)); assert.ok(isPublicDownload('/downloads/tieyou-web-' + 'a'.repeat(64) + '.zip'));
  assert.equal(isPublicDownload('/api/deck-library'), false); assert.equal(isPublicDownload('/downloads/android-release.json'), false);
  assert.equal(downloadResponse(request({ Range: 'bytes=1-2,5-6' }), path, bytes, date).status, 200);
});
