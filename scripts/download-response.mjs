import { createHash } from 'node:crypto';

export function isPublicDownload(pathname) {
  return /^\/downloads\/(?:tieyou-android(?:-\d+\.\d+\.\d+)?\.apk|tieyou-web-[a-f0-9]{64}\.zip)$/.test(pathname);
}

export function parseDownloadRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  // Multiple ranges are optional in HTTP. Serve the full representation if unsupported.
  if (!match || !match[1] && !match[2]) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || !size) return false;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function downloadResponse(request, pathname, body, modifiedAt) {
  const filename = pathname.slice('/downloads/'.length), apk = filename.endsWith('.apk');
  const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
  const modified = new Date(modifiedAt);
  const headers = {
    'Content-Type': apk ? 'application/vnd.android.package-archive' : 'application/zip',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Accept-Ranges': 'bytes', 'ETag': etag, 'Last-Modified': modified.toUTCString(),
    'Cache-Control': filename === 'tieyou-android.apk' ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  };
  const matches = request.headers.get('If-None-Match');
  if (matches && matches.split(',').some(tag => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)) return new Response(null, { status: 304, headers });
  const ifRange = request.headers.get('If-Range');
  const rangeMatches = !ifRange || ifRange === etag || !ifRange.startsWith('"') && !ifRange.startsWith('W/') && Date.parse(ifRange) >= Math.floor(modified.getTime() / 1000) * 1000;
  const range = request.method === 'GET' && rangeMatches ? parseDownloadRange(request.headers.get('Range'), body.length) : null;
  if (range === false) return new Response(null, { status: 416, headers: { ...headers, 'Cache-Control': 'no-store', 'Content-Range': `bytes */${body.length}`, 'Content-Length': '0' } });
  if (range) {
    const part = body.subarray(range.start, range.end + 1);
    return new Response(part, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`, 'Content-Length': String(part.length) } });
  }
  return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Length': String(body.length) } });
}
