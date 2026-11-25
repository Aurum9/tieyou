import { randomUUID } from 'node:crypto';
import { DEFAULT_TAG_NAMES, applyTagOverrides, applyTagAliases } from '../web/lib/tag-names.js';

const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function createTagAdminService(db, auth, { local = false, readVocabulary, onSettingsChange = (overrides, aliases) => { applyTagOverrides(overrides); applyTagAliases(aliases); } } = {}) {
  // This is an authenticated database identity, never a client-supplied username.
  let appliedRevision = -1;
  const publish = state => { if (state.revision >= appliedRevision) { onSettingsChange(state.overrides, state.aliases); appliedRevision = state.revision; } };
  const administrator = local ? null : await db.prepare('SELECT id FROM standalone_auth_accounts WHERE username_key=?').bind('黄金九').first();
  async function settings() {
    const state = await db.prepare('SELECT revision FROM tag_settings_state WHERE id=1').first();
    const { results } = await db.prepare('SELECT slug,label,visible,description_zh,include_in_analysis FROM tag_label_overrides ORDER BY slug').all();
    const overrides = Object.fromEntries(results.map(row => [row.slug, { label: row.label, visible: !!row.visible, descriptionZh: row.description_zh, includeInAnalysis: !!row.include_in_analysis }]));
    const included = new Set([...Object.keys(DEFAULT_TAG_NAMES), ...Object.keys(overrides)]);
    const aliases = Object.fromEntries((await readVocabulary()).filter(row => included.has(row.slug)).map(row => [row.slug, [row.label || row.slug, ...(row.aliases || [])]]));
    for (const slug of included) if (!Object.hasOwn(aliases, slug)) aliases[slug] = [slug];
    return { revision: state.revision, overrides, aliases };
  }
  async function access(request) {
    if (local) return { allowed: true, local: true };
    const account = await auth?.currentAccount(request);
    return { allowed: !!administrator && account?.id === administrator.id, local: false };
  }
  async function vocabulary() {
    const rows = await readVocabulary();
    const known = new Map(rows.map(row => [row.slug, row]));
    const version = await db.prepare('SELECT active_version FROM catalog_state WHERE id=1').first('active_version');
    const { results } = await db.prepare('SELECT slug,COUNT(*) AS card_count FROM catalog_tags WHERE version=? GROUP BY slug').bind(version).all();
    const normalize = value => String(value).normalize('NFKC').toLowerCase().trim();
    const aliases = new Map(rows.map(row => [normalize(row.slug), row.slug]));
    for (const row of rows) for (const name of [row.label || row.slug, ...(row.aliases || [])]) if (!aliases.has(normalize(name))) aliases.set(normalize(name), row.slug);
    const counts = new Map(), grouped = new Map();
    for (const result of results) {
      const canonical = aliases.get(normalize(result.slug)) || result.slug;
      const group = grouped.get(canonical) || []; group.push(result.slug); grouped.set(canonical, group);
      counts.set(canonical, result.card_count);
    }
    const overlapping = [...grouped].filter(([,raw]) => raw.length > 1).map(([slug,raw]) => ({ slug,raw }));
    if (overlapping.length) {
      const mappings = overlapping.flatMap(group => group.raw.map(raw => ({ slug: group.slug, raw })));
      const merged = await db.prepare(`SELECT json_extract(m.value,'$.slug') AS slug,COUNT(DISTINCT t.card_id) AS card_count
        FROM json_each(?) m CROSS JOIN catalog_tags t
        WHERE t.version=? AND t.slug=json_extract(m.value,'$.raw')
        GROUP BY json_extract(m.value,'$.slug')`).bind(JSON.stringify(mappings), version).all();
      for (const row of merged.results) counts.set(row.slug, row.card_count);
    }
    for (const slug of [...Object.keys(DEFAULT_TAG_NAMES), ...counts.keys(), ...Object.keys((await settings()).overrides)]) if (!known.has(slug)) known.set(slug, { slug, label: slug, aliases: [], parentSlugs: [] });
    return [...known.values()].map(row => ({ slug: row.slug, englishLabel: row.label || row.slug, aliases: row.aliases || [], description: row.description || '', parentSlugs: row.parentSlugs || [], defaultLabel: DEFAULT_TAG_NAMES[row.slug] || '', cardCount: counts.get(row.slug) || 0 }));
  }
  const initial = await settings(); publish(initial);
  return { settings, async handle(request) {
    const url = new URL(request.url);
    if (!['/api/tag-settings', '/api/admin/tags/access', '/api/admin/tags'].includes(url.pathname)) return null;
    try {
      if (url.pathname === '/api/tag-settings') { if (request.method !== 'GET') return reply({ error: { message: '请求方式无效' } }, 405); const current = await settings(); publish(current); return reply(current); }
      const permission = await access(request);
      if (url.pathname.endsWith('/access')) return request.method === 'GET' ? reply(permission) : reply({ error: { message: '请求方式无效' } }, 405);
      if (!permission.allowed) return reply({ error: { message: '仅管理员可管理标签' } }, 403);
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site' || request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      if (request.method === 'GET') return reply({ ...(await settings()), rows: await vocabulary() });
      if (request.method !== 'PUT') return reply({ error: { message: '请求方式无效' } }, 405);
      if (request.headers.get('Origin') !== url.origin) return reply({ error: { message: '请求来源无效' } }, 403);
      if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) return reply({ error: { message: '请求格式无效' } }, 415);
      const reader = request.body?.getReader(); if (!reader) return reply({ error: { message: '修改内容为空' } }, 400);
      const chunks = []; let length = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 128 * 1024) { await reader.cancel(); return reply({ error: { message: '单次修改内容过大' } }, 413); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply({ error: { message: '修改格式无效' } }, 400); }
      if (!Number.isSafeInteger(body?.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER || !Array.isArray(body.changes) || !body.changes.length || body.changes.length > 500) return reply({ error: { message: '请一次保存 1–500 个标签' } }, 400);
      const allowed = new Set((await vocabulary()).map(row => row.slug)), seen = new Set();
      for (const item of body.changes) {
        if (!item || !allowed.has(item.slug) || seen.has(item.slug) || typeof item.label !== 'string' || item.label.length > 100 || /[\u0000-\u001f\u007f]/u.test(item.label) || typeof item.visible !== 'boolean' || item.visible && !item.label.trim()) return reply({ error: { message: '标签内容无效，显示的标签需要填写译名' } }, 400);
        if (item.descriptionZh !== undefined && (typeof item.descriptionZh !== 'string' || item.descriptionZh.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.descriptionZh))) return reply({ error: { message: '中文释义格式无效或超过 4000 字' } }, 400);
        if (item.includeInAnalysis !== undefined && typeof item.includeInAnalysis !== 'boolean') return reply({ error: { message: '卡组统计开关无效' } }, 400);
        seen.add(item.slug);
      }
      const mutation = randomUUID(), next = body.revision + 1;
      const writes = [db.prepare('UPDATE tag_settings_state SET revision=?,mutation=? WHERE id=1 AND revision=?').bind(next, mutation, body.revision)];
      for (const item of body.changes) writes.push(db.prepare(`INSERT INTO tag_label_overrides(slug,label,visible,description_zh,include_in_analysis)
        SELECT ?,?,?,coalesce(?,(SELECT description_zh FROM tag_label_overrides WHERE slug=?),''),coalesce(?,(SELECT include_in_analysis FROM tag_label_overrides WHERE slug=?),1)
        WHERE EXISTS(SELECT 1 FROM tag_settings_state WHERE id=1 AND revision=? AND mutation=?)
        ON CONFLICT(slug) DO UPDATE SET label=excluded.label,visible=excluded.visible,description_zh=excluded.description_zh,include_in_analysis=excluded.include_in_analysis`).bind(item.slug, item.label.trim(), item.visible ? 1 : 0, item.descriptionZh === undefined ? null : item.descriptionZh.replace(/\r\n?/g, '\n').trim(), item.slug, item.includeInAnalysis === undefined ? null : item.includeInAnalysis ? 1 : 0, item.slug, next, mutation));
      const result = await db.batch(writes);
      if (!result[0].meta.changes) return reply({ error: { message: '标签已在其他页面修改，请重新载入后保存' } }, 409);
      const saved = await settings(); publish(saved); return reply(saved);
    } catch { return reply({ error: { message: '标签管理暂时无法使用，请重试' } }, 503); }
  } };
}
