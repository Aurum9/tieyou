import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createWorker } from '../server/worker.js';
import { createCatalogService, importCatalogBatch, activateCatalogVersion } from '../server/catalog-db.js';
import { openLocalD1 } from './local-d1.mjs';
import { readCatalogSource } from './catalog-seed.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(projectRoot, 'web');
const stateRoot = resolve(projectRoot, '.local');
await mkdir(stateRoot, { recursive: true });
const db = openLocalD1(resolve(stateRoot, 'catalog.sqlite'));
await db.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY);');
for (const filename of (await readdir(resolve(projectRoot, 'drizzle'))).filter(file => /^\d.*\.sql$/.test(file)).sort()) {
  if (await db.prepare('SELECT name FROM local_schema_migrations WHERE name=?').bind(filename).first()) continue;
  await db.exec(await readFile(resolve(projectRoot, 'drizzle', filename), 'utf8'));
  await db.prepare('INSERT INTO local_schema_migrations(name) VALUES (?)').bind(filename).run();
}
const source = await readCatalogSource(resolve(root, 'data'));
let meta;
try { meta = await createCatalogService(db).meta(); } catch { meta = null; }
if ((meta?.datasetVersion ?? meta?.version ?? meta?.activeVersion) !== source.version) {
  let cards = 0;
  for await (const batch of source.batches()) {
    await importCatalogBatch(db, batch); cards += batch.cards.length;
    if (cards % 5000 < batch.cards.length) process.stdout.write(`Preparing local card database: ${cards}/${source.manifest.counts.cards}\n`);
  }
  await activateCatalogVersion(db, source.activation);
}
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Local preview must listen on loopback');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
const worker = createWorker({ async serveAsset(pathname, request) {
  // Source-only card dumps are never served, including in development.
  if (pathname.startsWith('/data/') && !['/data/tag-vocabulary.json', '/data/playtest-tokens.json', '/data/coverage-report.md', '/data/DATA-LICENSE.md'].includes(pathname)) return new Response(null, { status: 404 });
  const path = resolve(root, '.' + pathname);
  if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 403 });
  try {
    let body = await readFile(path);
    if (pathname === '/data/tag-vocabulary.json') {
      const vocabulary = JSON.parse(body.toString());
      body = Buffer.from(JSON.stringify(vocabulary.map(({ slug, label, aliases, parentSlugs }) => ({ slug, label, aliases, parentSlugs }))));
    }
    return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return new Response(null, { status: error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500 }); }
} });
const server = createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const origin = `http://${headers.get('host') || `${host}:${port}`}`;
    const request = new Request(new URL(req.url, origin), { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }) });
    const response = await worker.fetch(request, { DB: db });
    const responseHeaders = Object.fromEntries(response.headers);
    let body = request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    if (body.length && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text\/|application\/json|image\/svg/.test(response.headers.get('Content-Type') || '')) {
      body = gzipSync(body); responseHeaders['content-encoding'] = 'gzip'; responseHeaders.vary = 'Accept-Encoding';
    }
    responseHeaders['content-length'] = String(body.length);
    res.writeHead(response.status, responseHeaders); res.end(body);
  } catch {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('请求未完成'); }
    else res.destroy();
  }
});
server.listen(port, host, () => process.stdout.write(`Local: http://${host}:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
