import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { clientDay } from './client-usage.mjs';

const root = resolve(process.env.EDH_STATE_DIR || '.local');
const db = new DatabaseSync(resolve(root, 'client-usage.sqlite'), { readOnly: true });
try {
  const now = Date.now(), day = clientDay(now), since = clientDay(now - 30 * 86400000);
  const all = (sql, ...values) => db.prepare(sql).all(...values);
  const number = (sql, ...values) => db.prepare(sql).get(...values).count;
  let policy = { minimumProtocol: 1, enforce: false, enforceAt: null };
  try { policy = JSON.parse(await readFile(resolve(root, 'client-policy.json'), 'utf8')); } catch { }
  console.log(JSON.stringify({
    measuredAt: new Date(now).toISOString(), dayTimezone: 'Asia/Shanghai',
    definitions: { observedDevices: '联网启动且允许统计的匿名标识数，清空数据或重装可能产生新标识；不等同于总安装量', downloads: '服务器完成的 APK GET 200 响应次数，不等同于成功安装或唯一下载人数', missingProtocol: '缺少协议标记的卡查请求，可能包含旧网页或爬虫；不等同于旧 App 台数' },
    observedDevices: number('SELECT COUNT(*) AS count FROM client_usage_installations'),
    activeToday: number('SELECT COUNT(*) AS count FROM client_usage_daily WHERE day=?', day),
    active7Days: number('SELECT COUNT(*) AS count FROM client_usage_installations WHERE last_seen>=?', now - 7 * 86400000),
    active30Days: number('SELECT COUNT(*) AS count FROM client_usage_installations WHERE last_seen>=?', now - 30 * 86400000),
    versionsActive30Days: all('SELECT version_name AS version, COUNT(*) AS devices FROM client_usage_installations WHERE last_seen>=? GROUP BY version_name ORDER BY devices DESC', now - 30 * 86400000),
    newlyObserved: all("SELECT strftime('%Y-%m-%d', first_seen/1000, 'unixepoch', '+8 hours') AS day, COUNT(*) AS devices FROM client_usage_installations GROUP BY day HAVING day>=? ORDER BY day DESC", since),
    dailyActive: all('SELECT day, version_name AS version, COUNT(*) AS devices FROM client_usage_daily WHERE day>=? GROUP BY day,version_name ORDER BY day DESC', since),
    downloads: all('SELECT day,version_name AS version,responses,bytes FROM client_download_daily WHERE day>=? ORDER BY day DESC', since),
    protocolRequests: all('SELECT day,protocol,requests FROM client_protocol_daily WHERE day>=? ORDER BY day DESC', since),
    policy,
  }, null, 2));
} finally { db.close(); }
