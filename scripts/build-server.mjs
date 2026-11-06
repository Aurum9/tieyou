import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, cp, rm } from 'node:fs/promises';
import { resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = resolve(root, 'web');
const out = resolve(root, 'dist');
if (relative(root, out) !== 'dist') throw new Error('Unexpected build directory');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
const assets = {};
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Symlinks cannot be bundled');
    const path = resolve(directory, entry.name);
    const key = '/' + relative(webRoot, path).replaceAll('\\', '/');
    if (entry.isDirectory()) { if (key !== '/data') await collect(path); continue; }
    if (!entry.isFile() || !types[extname(path)]) continue;
    const body = await readFile(path, 'utf8');
    assets[key] = { body, type: types[extname(path)], etag: '"' + createHash('sha256').update(body).digest('hex').slice(0, 24) + '"' };
  }
}
await collect(webRoot);
// Only vocabulary and the two public attribution/coverage documents are browser assets.
const vocabulary = JSON.parse(await readFile(resolve(webRoot, 'data/tag-vocabulary.json'), 'utf8'));
assets['/data/tag-vocabulary.json'] = { type: types['.json'], body: JSON.stringify(vocabulary.map(({ slug, label, aliases, parentSlugs }) => ({ slug, label, aliases, parentSlugs }))) };
for (const filename of ['coverage-report.md', 'DATA-LICENSE.md']) assets['/data/' + filename] = { type: types['.md'], body: await readFile(resolve(webRoot, 'data', filename), 'utf8') };
if (Object.keys(assets).some(key => /catalog-\d|search-metadata|manifest\.json/.test(key))) throw new Error('Card bulk data cannot enter the browser bundle');
const total = Object.values(assets).reduce((sum, asset) => sum + Buffer.byteLength(asset.body), 0);
if (total > 3 * 1024 * 1024) throw new Error('Browser assets exceed the build budget');
await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, 'server'), { recursive: true });
await mkdir(resolve(out, '.openai'), { recursive: true });
await build({ stdin: { contents: `import {createWorker} from './server/worker.js'; export default createWorker({assets:${JSON.stringify(assets)}});`, resolveDir: root, sourcefile: 'worker-entry.js' }, outfile: resolve(out, 'server/index.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, legalComments: 'none' });
await cp(resolve(root, '.openai/hosting.json'), resolve(out, '.openai/hosting.json'));
await cp(resolve(root, 'drizzle'), resolve(out, '.openai/drizzle'), { recursive: true });
const workerBytes = (await readFile(resolve(out, 'server/index.js'))).byteLength;
await writeFile(resolve(out, '.openai/build-summary.json'), JSON.stringify({ assets: Object.keys(assets).length, browserBytes: total, workerBytes, bulkCardAssets: 0 }, null, 2) + '\n');
console.log(`Worker built: ${Object.keys(assets).length} frontend assets, ${total.toLocaleString()} bytes; bulk card assets: 0`);
