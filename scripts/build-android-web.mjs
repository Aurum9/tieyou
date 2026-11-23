import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function webZip(files) {
  const locals = [], directory = [], seen = new Set();
  let offset = 0, total = 0;
  for (const { name, data } of files) {
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || name.includes('..') || name.length > 240 || seen.has(name)) throw new Error('Invalid web archive path');
    seen.add(name); total += data.length;
    if (total > 64 * 1024 * 1024 || seen.size > 5000) throw new Error('Web bundle exceeds client limits');
    const filename = Buffer.from(name), compressed = deflateRawSync(data), checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    directory.push(entry, filename); offset += local.length + filename.length + compressed.length;
  }
  const directorySize = directory.reduce((sum, buffer) => sum + buffer.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  const archive = Buffer.concat([...locals, ...directory, end]);
  if (archive.length > 32 * 1024 * 1024) throw new Error('Compressed web bundle exceeds client limit');
  return archive;
}

export async function buildAndroidWeb({ assets, output = resolve('dist/android'), builtAt = Date.now() } = {}) {
  const root = assets ? resolve(assets) : resolve('web');
  const files = [];
  const walk = async folder => {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, item.name), name = relative(root, file).replaceAll('\\', '/');
      if (item.isDirectory()) {
        if (folder === root && !['assets', 'lib'].includes(item.name)) continue;
        await walk(file);
      } else if (item.isFile() && name !== 'web-build.json') {
        let data = await readFile(file);
        if (name === 'index.html' && !data.toString().includes('window.tieyouAndroid = true')) data = Buffer.from(data.toString().replace('<head>', '<head><script>window.tieyouAndroid = true;document.documentElement.classList.add("tieyou-android");</script>'));
        files.push({ name, data });
      }
    }
  };
  await walk(root);
  for (const filename of ['tag-vocabulary.json', 'playtest-tokens.json', 'DATA-LICENSE.md']) files.push({ name: 'data/' + filename, data: await readFile(join(root, 'data', filename)) });
  files.push({ name: 'web-build.json', data: Buffer.from(JSON.stringify({ builtAt }) + '\n') });
  if (assets) await writeFile(join(root, 'web-build.json'), files.at(-1).data);
  files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const archive = webZip(files), hash = createHash('sha256').update(archive).digest('hex'), name = `tieyou-web-${hash}.zip`;
  const release = { version: 1, minVersionCode: 7, builtAt, sha256: hash, size: archive.length, url: `https://sbwsz.cn/downloads/${name}` };
  await mkdir(output, { recursive: true }); await writeFile(join(output, name), archive); await writeFile(join(output, 'web-release.json'), JSON.stringify(release, null, 2) + '\n');
  return { release, path: join(output, name), files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = key => { const i = process.argv.indexOf(key); return i >= 0 ? process.argv[i + 1] : undefined; };
  const result = await buildAndroidWeb({ assets: option('--assets'), output: option('--out') });
  console.log(`Web update: ${result.files} files, ${result.release.size} bytes, ${result.path}`);
}
