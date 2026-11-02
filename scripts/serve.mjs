import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, dirname, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
    const info = await stat(path);
    if (!info.isFile()) { res.writeHead(404); res.end(); return; }
    const contentType = types[extname(path)] || 'application/octet-stream';
    const gzip = /gzip/.test(req.headers['accept-encoding'] || '') && /text\/|application\/json|image\/svg/.test(contentType);
    const headers = { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Accept-Encoding' };
    if (gzip) headers['Content-Encoding'] = 'gzip'; else headers['Content-Length'] = info.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    if (gzip) await pipeline(createReadStream(path), createGzip(), res); else await pipeline(createReadStream(path), res);
  } catch (error) {
    if (!res.headersSent) { res.writeHead(error.code === 'ENOENT' ? 404 : 400); res.end('无法读取资源'); }
    else res.destroy();
  }
});
server.listen(port, host, () => process.stdout.write(`Local: http://${host}:${port}\n`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
