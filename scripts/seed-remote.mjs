import { readCatalogSource } from './catalog-seed.mjs';

if (process.argv.length > 2) throw new Error('导入配置只能通过标准输入传入');
const input = await new Promise((resolve, reject) => {
  let value = '';
  const terminal = process.stdin.isTTY;
  const finish = error => {
    process.stdin.removeListener('data', onData); process.stdin.removeListener('end', onEnd);
    if (terminal) process.stdin.setRawMode(false);
    process.stdin.pause(); error ? reject(error) : resolve(value);
  };
  const onData = chunk => {
    value += chunk;
    if (value.includes('\u0003')) finish(new Error('导入已取消'));
    else if (value.length > 32768) finish(new Error('导入配置过大'));
    else if (value.includes('\n') || value.includes('\r')) finish();
  };
  const onEnd = () => finish();
  if (terminal) { process.stdin.setRawMode(true); process.stderr.write('Ready for catalog seed JSON on stdin (input is hidden).\n'); }
  process.stdin.setEncoding('utf8'); process.stdin.on('data', onData); process.stdin.once('end', onEnd); process.stdin.resume();
});
let config;
try { config = JSON.parse(input); } catch { throw new Error('导入配置 JSON 无效'); }
if (!config || typeof config !== 'object' || Array.isArray(config) || typeof config.origin !== 'string') throw new Error('导入配置无效');
let url;
try { url = new URL(config.origin); } catch { throw new Error('需要有效的站点根地址'); }
if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('需要有效的站点根地址');
if (typeof config.token !== 'string' || !config.token.trim() || /[\r\n\0]/.test(config.token)) throw new Error('缺少站点服务访问凭据');
if (typeof config.sourcePath !== 'string' || !config.sourcePath) throw new Error('缺少卡库源目录');
const source = await readCatalogSource(config.sourcePath);
async function submit(body) {
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error('导入批次过大');
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(new URL('/api/catalog/import', url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': 'Bearer ' + config.token }, body: encoded, redirect: 'error', signal: AbortSignal.timeout(45000) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`导入失败（HTTP ${response.status}）：${result.error?.message || '请求未完成'}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return result;
    } catch (error) {
      if (attempt === 3 || error.retryable === false) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}
let batches = 0, cards = 0;
for await (const batch of source.batches()) {
  await submit(batch); batches++; cards += batch.cards.length;
  if (batches % 10 === 0) console.log(`Imported ${cards}/${source.manifest.counts.cards} cards (${batches} batches)`);
}
const result = await submit(source.activation);
console.log(JSON.stringify({ version: source.version, batches, cards, activated: result }));
