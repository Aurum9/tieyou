import { deflateSync } from 'node:zlib';
import { crc32 } from '../../scripts/build-android-web.mjs';
export function pngFixture(width = 1440, height = 1920) {
  const chunk = (name, bytes) => {
    const out = Buffer.alloc(bytes.length + 12); out.writeUInt32BE(bytes.length); out.write(name, 4); bytes.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, bytes.length + 8)), bytes.length + 8); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
