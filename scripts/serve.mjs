import { createServer } from 'node:http';
import { readFile, readdir, mkdir, access, stat } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { isIP } from 'node:net';
import { createWorker } from '../server/worker.js';
import { importCatalogBatch, activateCatalogVersion } from '../server/catalog-db.js';
import { openLocalD1 } from './local-d1.mjs';
import { readCatalogManifest, readCatalogSource } from './catalog-seed.mjs';
import { createStandaloneAuth } from './standalone-auth.mjs';
import { createFeedbackService } from './standalone-feedback.mjs';
import { createClientUsage } from './client-usage.mjs';
import { createScoreboardService } from './standalone-scoreboard.mjs';
import { createDeckShareService } from './standalone-deck-shares.mjs';
import { createPosterStore } from './deck-poster-store.mjs';
import { createTagAdminService } from './standalone-tag-admin.mjs';
import { isPublicDownload, downloadResponse } from './download-response.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(projectRoot, 'web');
const stateRoot = resolve(process.env.EDH_STATE_DIR || resolve(projectRoot, '.local'));
const dataRoot = resolve(root, 'data');
const bundledCatalog = resolve(process.env.EDH_CATALOG_SOURCE || dataRoot);
const catalogReleases = resolve(stateRoot, 'catalog-releases');
const catalogAssets = new Set(['tag-vocabulary.json', 'playtest-tokens.json', 'coverage-report.md', 'DATA-LICENSE.md']);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('The application server must listen on loopback');
const publicOrigin = process.env.EDH_PUBLIC_ORIGIN ? new URL(process.env.EDH_PUBLIC_ORIGIN).origin : null;
const previewAccount = process.env.EDH_PREVIEW_ACCOUNT?.trim();
if (publicOrigin && previewAccount) throw new Error('Preview accounts cannot be used on a public site');
if (publicOrigin && !publicOrigin.startsWith('https://')) throw new Error('A public site requires HTTPS');

await mkdir(stateRoot, { recursive: true });
const db = openLocalD1(resolve(stateRoot, 'catalog.sqlite'));
await db.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY);');
for (const filename of (await readdir(resolve(projectRoot, 'drizzle'))).filter(file => /^\d.*\.sql$/.test(file)).sort()) {
  if (await db.prepare('SELECT name FROM local_schema_migrations WHERE name=?').bind(filename).first()) continue;
  await db.exec(await readFile(resolve(projectRoot, 'drizzle', filename), 'utf8'));
  await db.prepare('INSERT INTO local_schema_migrations(name) VALUES (?)').bind(filename).run();
}
const activeSnapshot = db.prepare('SELECT active_version FROM catalog_state WHERE id=1');
const activeAtStart = (await activeSnapshot.first())?.active_version;
const bundledVersion = (await readCatalogManifest(bundledCatalog)).version;
const validVersion = version => /^catalog-[a-f0-9]{24}$/.test(version || '');
const hasPublishedCatalog = validVersion(activeAtStart) && await access(resolve(catalogReleases, activeAtStart, 'manifest.json')).then(() => true, () => false);
const usePublishedCatalog = publicOrigin ? !!activeAtStart : !process.env.EDH_CATALOG_SOURCE && hasPublishedCatalog;
const source = usePublishedCatalog ? null : await readCatalogSource(bundledCatalog);
if (source && activeAtStart !== source.version) {
  let cards = 0;
  for await (const batch of source.batches()) {
    await importCatalogBatch(db, batch); cards += batch.cards.length;
    if (cards % 5000 < batch.cards.length) process.stdout.write(`Preparing local card database: ${cards}/${source.manifest.counts.cards}\n`);
  }
  await activateCatalogVersion(db, source.activation);
}
const auth = previewAccount ? null : await createStandaloneAuth(db);
const feedback = createFeedbackService(db, auth);
const scoreboard = createScoreboardService(db, auth);
const deckShares = createDeckShareService(db, auth, { readIndex: () => readFile(resolve(root, 'index.html'), 'utf8'), posterStore: createPosterStore(resolve(stateRoot, 'deck-posters')) });
let vocabularyCache = null;
async function readActiveTagVocabulary() {
  const version = (await activeSnapshot.first())?.active_version;
  const directory = version !== bundledVersion && validVersion(version) ? resolve(catalogReleases, version) : bundledCatalog;
  if (vocabularyCache?.directory === directory) return vocabularyCache.rows;
  const rows = JSON.parse(await readFile(resolve(directory, 'tag-vocabulary.json'), 'utf8'));
  vocabularyCache = { directory, rows }; return rows;
}
const tagAdmin = await createTagAdminService(db, auth, { local: !publicOrigin, readVocabulary: readActiveTagVocabulary });
const usageDB = openLocalD1(resolve(stateRoot, 'client-usage.sqlite'));
const clientUsage = await createClientUsage(usageDB, { policyPath: resolve(process.env.EDH_CLIENT_POLICY_PATH || resolve(stateRoot, 'client-policy.json')), releasePath: resolve(root, 'downloads/android-release.json') });
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
const worker = createWorker({ async serveAsset(pathname, request) {
  const path = resolve(root, '.' + pathname);
  if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 403 });
  const inCatalog = path === dataRoot || path.startsWith(dataRoot + sep);
  const name = pathname.slice('/data/'.length);
  if (inCatalog && !(pathname.startsWith('/data/') && catalogAssets.has(name))) return new Response(null, { status: 404 });
  try {
    let assetPath = inCatalog ? resolve(bundledCatalog, name) : path;
    if (inCatalog && (publicOrigin || usePublishedCatalog)) {
      const version = (await activeSnapshot.first())?.active_version;
      if (version !== bundledVersion && validVersion(version)) assetPath = resolve(catalogReleases, version, name);
    }
    let body = await readFile(assetPath);
    if (isPublicDownload(pathname)) return downloadResponse(request, pathname, body, (await stat(assetPath)).mtime);
    if (pathname === '/data/tag-vocabulary.json') {
      const vocabulary = JSON.parse(body.toString());
      body = Buffer.from(JSON.stringify(vocabulary.map(({ slug, label, aliases, parentSlugs }) => ({ slug, label, aliases, parentSlugs }))));
    }
    return new Response(request.method === 'HEAD' ? null : body, { headers: { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': extname(path) === '.js' ? 'private, no-store' : 'private, no-cache', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) { return new Response(null, { status: error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500 }); }
} });
const server = createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value == null || name.startsWith('oai-authenticated-')) continue;
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
    if (previewAccount) headers.set('oai-authenticated-user-id', `local-preview:${previewAccount}`);
    const origin = publicOrigin || `http://${headers.get('host') || `${host}:${port}`}`;
    const url = new URL(req.url, origin);
    if (publicOrigin && url.origin !== publicOrigin) { res.writeHead(400); res.end(); return; }
    if (publicOrigin && url.pathname === '/api/catalog/import') { res.writeHead(404); res.end(); return; }
    const request = new Request(url, { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: req, duplex: 'half' }) });
    // The public server listens on loopback behind Caddy. Caddy appends the verified peer address.
    const forwarded = publicOrigin ? headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : '';
    const clientAddress = isIP(forwarded || '') ? forwarded : req.socket.remoteAddress;
    let response = await clientUsage.handle(request, { clientAddress });
    if (!response) response = await auth?.handle(request, { clientAddress });
    if (!response) response = await feedback.handle(request);
    if (!response) response = await scoreboard.handle(request);
    if (!response) response = await deckShares.handle(request);
    if (!response) response = await tagAdmin.handle(request);
    if (!response) {
      if (auth && url.pathname === '/api/deck-library') {
        const visitor = await auth.visitorId(request);
        if (visitor) request.headers.set('oai-authenticated-user-id', visitor);
      }
      response = await worker.fetch(request, { DB: db });
    }
    const responseHeaders = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) responseHeaders['set-cookie'] = cookies;
    let body = request.method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await response.arrayBuffer());
    if (body.length && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /text\/|application\/json|image\/svg/.test(response.headers.get('Content-Type') || '')) {
      body = gzipSync(body); responseHeaders['content-encoding'] = 'gzip'; responseHeaders.vary = 'Accept-Encoding';
    }
    if (response.status === 304 || response.status === 204) delete responseHeaders['content-length'];
    else if (request.method !== 'HEAD' || !responseHeaders['content-length']) responseHeaders['content-length'] = String(body.length);
    if (request.method === 'GET' && response.status === 200 && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(clientAddress) && /^\/downloads\/tieyou-android(?:-\d+\.\d+\.\d+)?\.apk$/.test(url.pathname)) {
      res.once('finish', () => { void clientUsage.recordDownload(url.pathname, body.length).catch(() => {}); });
    }
    res.writeHead(response.status, responseHeaders); res.end(body);
  } catch {
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('请求未完成'); }
    else res.destroy();
  }
});
server.listen(port, host, () => process.stdout.write(`Local: http://${host}:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); usageDB.close(); process.exit(0); }));
