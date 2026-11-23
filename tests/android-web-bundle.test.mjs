import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { crc32, webZip } from '../scripts/build-android-web.mjs';

test('web ZIP preserves binary assets, paths and checksums, with a valid central directory', () => {
  const files = [{ name: 'index.html', data: Buffer.from('<head>铁有</head>') }, { name: 'assets/back.png', data: Buffer.from([0, 255, 32, 11, 0]) }];
  const zip = webZip(files); let offset = 0;
  for (const file of files) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26), start = offset + 30 + nameLength;
    assert.equal(zip.subarray(offset + 30, start).toString(), file.name);
    const restored = inflateRawSync(zip.subarray(start, start + size));
    assert.deepEqual(restored, file.data); assert.equal(zip.readUInt32LE(offset + 14), crc32(restored)); offset = start + size;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt32LE(zip.length - 6), offset);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
test('web ZIP rejects duplicate paths and paths the Android client refuses', () => {
  for (const name of ['../app.js', '/app.js', 'lib/../../app.js', 'lib\\app.js', 'file name.js']) assert.throws(() => webZip([{ name, data: Buffer.from('x') }]));
  assert.throws(() => webZip([{ name: 'app.js', data: Buffer.from('a') }, { name: 'app.js', data: Buffer.from('b') }]));
});
