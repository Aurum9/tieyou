import { freshTable, validateGameRecord } from './scoreboard-model.js';
import { clientHeaders } from './client-usage.js';

const prefix = 'tieyou.scoreboard.v1.';
export function createScoreboardStorage({ storage = globalThis.localStorage, fetcher = globalThis.fetch, onChange = () => {} } = {}) {
  let owner = 'guest', data, syncing = false, more = false, offset = 0, status = '', ready;
  const key = () => prefix + encodeURIComponent(owner);
  const persist = () => { storage.setItem(key(), JSON.stringify(data)); onChange(); };
  async function request(path, body) {
    const response = await fetcher(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000), headers: clientHeaders(body ? { 'Content-Type': 'application/json', 'X-Tieyou-Scoreboard-Owner': encodeURIComponent(owner.slice(8)) } : {}), ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || '记录同步失败');
    return result;
  }
  async function init() {
    try { const session = await request('/api/auth/session'); owner = session.username ? 'account:' + session.username : 'guest'; storage.setItem(prefix + 'owner', owner); }
    catch { owner = storage.getItem(prefix + 'owner') || 'guest'; }
    const raw = storage.getItem(key());
    data = raw ? JSON.parse(raw) : { table: freshTable(), records: [] };
    if (!Array.isArray(data.records) || !Array.isArray(data.table?.players) || data.table.players.length !== 4 || !['setup', 'playing', 'ended'].includes(data.table.phase)) throw new Error('本机计分板记录无法读取');
    validateGameRecord({ id: 'table-validation-only', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), first: 0, winner: 0, players: data.table.players });
    if (data.table.phase !== 'setup' && (!data.table.game || !/^[a-zA-Z0-9-]{16,64}$/.test(data.table.game.id) || !Number.isFinite(Date.parse(data.table.game.startedAt)) || !Number.isInteger(data.table.game.first) || data.table.game.first < 0 || data.table.game.first > 3)) throw new Error('本机对局进度无法读取');
    data.records = data.records.map(item => ({ record: validateGameRecord(item.record), pending: !!item.pending }));
    status = owner === 'guest' ? '保存在此设备' : '记录跟随账号';
    void sync();
  }
  function merge(records) {
    const map = new Map(data.records.map(item => [item.record.id, item]));
    for (const value of records) {
      const record = validateGameRecord(value), local = map.get(record.id);
      if (local?.pending && local.record.noteUpdatedAt > record.noteUpdatedAt) continue;
      map.set(record.id, { record, pending: false });
    }
    data.records = [...map.values()].sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
  }
  async function sync(loadMore = false) {
    if (syncing || owner === 'guest' || !data) return;
    syncing = true; let changedDuringUpload = false;
    try {
      const page = await request('/api/scoreboard/records?offset=' + (loadMore ? offset : 0));
      if ('account:' + page.username !== owner) throw new Error('账号已改变，请重新打开页面');
      // Verify current account before sending any locally queued private record.
      merge(page.records); more = page.more; offset = (loadMore ? offset : 0) + page.records.length; persist();
      for (const item of data.records.filter(item => item.pending)) {
        const sent = item.record;
        const reply = await request('/api/scoreboard/records', sent);
        if (item.record.noteUpdatedAt === sent.noteUpdatedAt) { item.record = reply.record ? validateGameRecord(reply.record) : sent; item.pending = false; }
        else changedDuringUpload = true;
        persist();
      }
      status = '记录已同步';
    } catch (error) { status = error.message.includes('账号已改变') ? error.message : '已保存在本机，联网后同步'; }
    finally { syncing = false; onChange(); if (changedDuringUpload) queueMicrotask(() => { void sync(); }); }
  }
  ready = init();
  return {
    ready, get table() { return data.table; }, get records() { return data.records; }, get status() { return status; }, get more() { return more; },
    saveTable(table) { const previous = data.table; data.table = table; try { persist(); } catch (error) { data.table = previous; throw error; } },
    finish(record, table) {
      record = validateGameRecord(record);
      const previous = data; data = { table, records: [{ record, pending: owner !== 'guest' }, ...data.records.filter(item => item.record.id !== record.id)] };
      try { persist(); } catch (error) { data = previous; throw error; }
      void sync();
    },
    annotate(id, note) {
      const item = data.records.find(item => item.record.id === id);
      if (!item) throw new Error('未找到这场游戏');
      const previous = { ...item };
      const timestamp = Math.max(Date.now(), Date.parse(item.record.noteUpdatedAt) + 1);
      item.record = validateGameRecord({ ...item.record, note: note.trim(), noteUpdatedAt: new Date(timestamp).toISOString() }); item.pending = owner !== 'guest';
      try { persist(); } catch (error) { Object.assign(item, previous); throw error; }
      void sync();
    }, sync,
  };
}
