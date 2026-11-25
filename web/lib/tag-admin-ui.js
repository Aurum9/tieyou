import { applyTagSettings } from './tag-settings.js';

const el = (tag, className = '', text = '') => { const item = document.createElement(tag); item.className = className; item.textContent = text; return item; };
const button = (text, action, className = 'button') => { const item = el('button', className, text); item.type = 'button'; item.addEventListener('click', action); return item; };
const normalize = value => String(value).normalize('NFKC').toLowerCase().trim();
const same = (a, b) => a.label === b.label && a.visible === b.visible && (a.descriptionZh || '') === (b.descriptionZh || '') && (a.includeInAnalysis === true) === (b.includeInAnalysis === true);

export function createTagAdminUI({ container, onBack, onAccount, onCatalog }) {
  let rows = [], children = new Map(), revision = 0, loaded = false, busy = false;
  let page = 0, parent = null, query = '', filter = 'all', order = 'count-desc', pageRows = [];
  const base = new Map(), edits = new Map(), expanded = new Set(), pageSize = 50;
  const effective = slug => edits.get(slug) || base.get(slug) || { label: '', visible: true, descriptionZh: '', includeInAnalysis: false };
  const label = slug => effective(slug).label || slug;
  const error = el('p', 'deck-form-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const status = el('span', 'tag-admin-status'); status.setAttribute('role', 'status');
  const save = button('保存修改', saveChanges, 'button button-primary');
  const reset = button('撤销未保存修改', () => { edits.clear(); renderRows(); });
  const retry = button('重新载入', () => { edits.clear(); void load(); }); retry.hidden = true;
  const search = el('input', 'deck-input tag-admin-search'); search.type = 'search'; search.placeholder = '英文标签、中文译名或解释'; search.setAttribute('aria-label', '搜索标签');
  const visibility = el('select', 'deck-input'); visibility.setAttribute('aria-label', '标签筛选');
  for (const [value, title] of [['all', '全部标签'], ['visible', '显示'], ['hidden', '隐藏'], ['untranslated', '未填写译名'], ['translated', '已填写译名'], ['description-missing', '未译释义'], ['description-done', '已译释义'], ['analysis', '计入卡组统计'], ['no-analysis', '不计入卡组统计'], ['edited', '未保存修改']]) { const option = el('option', '', title); option.value = value; visibility.append(option); }
  const ordering = el('select', 'deck-input'); ordering.setAttribute('aria-label', '标签排序');
  for (const [value, title] of [['count-desc', '卡牌数量 ↓'], ['count-asc', '卡牌数量 ↑'], ['name', '英文名称']]) { const option = el('option', '', title); option.value = value; ordering.append(option); }
  const bulk = el('div', 'tag-admin-bulk'); bulk.append(el('span', '', '本页批量'));
  const bulkInputs = new Map();
  for (const [field, title] of [['visible', '可见'], ['includeInAnalysis', '统计']]) {
    const label = el('label'), input = el('input'); input.type = 'checkbox'; input.setAttribute('aria-label', '本页全部' + title);
    input.addEventListener('change', () => {
      for (const row of pageRows) { const value = { ...effective(row.slug), [field]: input.checked }; if (same(value, base.get(row.slug))) edits.delete(row.slug); else edits.set(row.slug, value); }
      renderRows();
    }); label.append(input, document.createTextNode(title)); bulk.append(label); bulkInputs.set(field, input);
  }
  function updateBulk() { for (const [field, input] of bulkInputs) { const n = pageRows.filter(row => effective(row.slug)[field] === true).length; input.checked = !!pageRows.length && n === pageRows.length; input.indeterminate = n > 0 && n < pageRows.length; input.disabled = busy || !pageRows.length; } }
  const trail = el('div', 'tag-admin-trail');
  const table = el('table', 'tag-admin-table');
  const head = el('thead'), tr = el('tr');
  for (const title of ['英文标签 / 解释', '中文译名', '可见', '卡组统计', '上级 / 下级']) { const th = el('th', '', title); th.scope = 'col'; tr.append(th); }
  head.append(tr); const body = el('tbody'); table.append(head, body);
  const count = el('span', 'tag-admin-count');
  const previous = button('上一页', () => { page--; renderRows(); });
  const next = button('下一页', () => { page++; renderRows(); });
  function updateStatus() {
    status.textContent = busy ? (loaded ? '正在保存…' : '正在载入…') : edits.size ? edits.size + ' 项未保存' : '已保存';
    updateBulk();
    save.disabled = busy || !edits.size; reset.disabled = busy || !edits.size;
    for (const input of body.querySelectorAll('input,textarea')) input.disabled = busy;
  }
  function edit(row, value, element) {
    if (same(value, base.get(row.slug))) edits.delete(row.slug); else edits.set(row.slug, value);
    element.classList.toggle('is-dirty', edits.has(row.slug)); updateStatus();
  }
  function goParent(slug) { parent = slug; query = ''; search.value = ''; page = 0; renderRows(); }
  function renderRows() {
    const needle = normalize(query);
    const found = rows.filter(row => {
      const value = effective(row.slug);
      return (!parent || row.parentSlugs.includes(parent))
        && (filter === 'all' || filter === 'visible' && value.visible || filter === 'hidden' && !value.visible || filter === 'untranslated' && !value.label || filter === 'translated' && !!value.label || filter === 'description-missing' && !!row.description && !value.descriptionZh || filter === 'description-done' && !!value.descriptionZh || filter === 'analysis' && value.includeInAnalysis === true || filter === 'no-analysis' && value.includeInAnalysis !== true || filter === 'edited' && edits.has(row.slug))
        && (!needle || normalize([row.slug, row.englishLabel, row.description, value.descriptionZh || '', value.label, ...row.aliases].join(' ')).includes(needle));
    });
    const compare = (a, b) => (order === 'name' ? 0 : (order === 'count-asc' ? 1 : -1) * (a.cardCount - b.cardCount)) || a.slug.localeCompare(b.slug, 'en');
    found.sort(compare);
    if (needle) {
      const rank = row => {
        const terms = [row.slug, effective(row.slug).label, row.englishLabel, ...row.aliases].map(normalize);
        return terms.includes(needle) ? 0 : terms.some(term => term.startsWith(needle)) ? 1 : terms.some(term => term.includes(needle)) ? 2 : 3;
      };
      found.sort((a, b) => rank(a) - rank(b) || compare(a, b));
    }
    page = Math.max(0, Math.min(page, Math.ceil(found.length / pageSize) - 1));
    body.replaceChildren(); trail.replaceChildren();
    if (parent) trail.append(button('全部标签', () => goParent(null), 'text-button'), document.createTextNode(' / ' + label(parent)));
    pageRows = found.slice(page * pageSize, (page + 1) * pageSize);
    for (const row of pageRows) {
      const item = el('tr', 'tag-admin-row' + (edits.has(row.slug) ? ' is-dirty' : '')); item.dataset.slug = row.slug;
      const english = el('td', 'tag-admin-english'), details = el('details'), summary = el('summary', '', row.slug);
      details.append(summary); details.open = expanded.has(row.slug);
      if (row.englishLabel !== row.slug) details.append(el('p', 'tag-admin-english-label', row.englishLabel));
      if (row.description) details.append(el('span', 'tag-admin-source-caption', '英文释义'), el('p', 'tag-admin-description', row.description));
      if (row.aliases.length) details.append(el('p', 'tag-admin-aliases', '别名：' + row.aliases.join(' / ')));
      const more = el('div', 'tag-admin-row-links');
      const source = el('a', '', 'Scryfall'); source.href = 'https://tagger.scryfall.com/tags/card/' + encodeURIComponent(row.slug); source.target = '_blank'; source.rel = 'noreferrer';
      more.append(button('查看卡牌', () => onCatalog(row.slug), 'text-button'), source); details.append(more);
      const meta = el('div', 'tag-admin-meta');
      const translate = button(effective(row.slug).descriptionZh ? '编辑释义' : '翻译释义', () => { details.open = true; descriptionWrap.hidden = false; expanded.add(row.slug); description.focus(); }, 'text-button tag-admin-translate');
      meta.append(el('small', 'tag-admin-card-count', row.cardCount + ' 张'), translate); english.append(details, meta);
      const name = el('td', 'tag-admin-name'), input = el('input', 'deck-input tag-admin-label'); input.type = 'text'; input.value = effective(row.slug).label; input.placeholder = '未填写'; input.maxLength = 100; input.setAttribute('aria-label', row.slug + ' 中文译名');
      input.addEventListener('input', () => edit(row, { ...effective(row.slug), label: input.value }, item)); name.append(input);
      const descriptionWrap = el('label', 'tag-admin-description-editor'); descriptionWrap.hidden = !details.open;
      const description = el('textarea', 'deck-input tag-admin-description-zh'); description.rows = 3; description.maxLength = 4000; description.placeholder = '中文释义'; description.value = effective(row.slug).descriptionZh || ''; description.setAttribute('aria-label', row.slug + ' 中文释义');
      description.addEventListener('input', () => { edit(row, { ...effective(row.slug), descriptionZh: description.value }, item); translate.textContent = description.value ? '编辑释义' : '翻译释义'; });
      descriptionWrap.append(el('span', '', '中文释义'), description); name.append(descriptionWrap);
      details.addEventListener('toggle', () => { descriptionWrap.hidden = !details.open; if (details.open) expanded.add(row.slug); else expanded.delete(row.slug); });
      const visible = el('td', 'tag-admin-visible'), toggle = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = effective(row.slug).visible; checkbox.setAttribute('aria-label', row.slug + ' 显示');
      checkbox.addEventListener('change', () => {
        edit(row, { ...effective(row.slug), visible: checkbox.checked }, item);
      }); toggle.append(checkbox, document.createTextNode('显示')); visible.append(toggle);
      const analysis = el('td', 'tag-admin-analysis'), analysisLabel = el('label'), analysisInput = el('input');
      analysisInput.type = 'checkbox'; analysisInput.checked = effective(row.slug).includeInAnalysis === true; analysisInput.setAttribute('aria-label', row.slug + ' 计入卡组统计');
      analysisInput.addEventListener('change', () => edit(row, { ...effective(row.slug), includeInAnalysis: analysisInput.checked }, item));
      analysisLabel.append(analysisInput, document.createTextNode('统计')); analysis.append(analysisLabel);
      const parents = el('td', 'tag-admin-parents');
      if (row.parentSlugs.length) {
        parents.append(el('span', 'tag-admin-parent-caption', '上级：'));
        for (const slug of row.parentSlugs) { const parentLink = button(label(slug), () => goParent(slug), 'text-button'); parentLink.title = slug; parents.append(parentLink); }
      }
      if (children.has(row.slug)) parents.append(button('下级 ' + children.get(row.slug), () => goParent(row.slug), 'text-button tag-admin-children'));
      item.append(english, name, visible, analysis, parents); body.append(item);
    }
    if (!found.length) { const row = el('tr'), cell = el('td', 'deck-muted', '没有匹配的标签'); cell.colSpan = 5; row.append(cell); body.append(row); }
    previous.disabled = page === 0; next.disabled = (page + 1) * pageSize >= found.length;
    count.textContent = found.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, found.length)} / ${found.length}` : '0';
    updateStatus();
  }
  async function request(options) {
    const response = await fetch('/api/admin/tags', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
    const result = await response.json(); if (!response.ok) { const failure = new Error(result.error?.message || '标签管理暂时无法使用'); failure.status = response.status; throw failure; } return result;
  }
  async function load() {
    busy = true; error.hidden = true; retry.hidden = true; status.textContent = '正在载入…'; updateStatus();
    try {
      const data = await request(); rows = data.rows; revision = data.revision; children = new Map(); base.clear();
      for (const row of rows) {
        base.set(row.slug, data.overrides[row.slug] || { label: row.defaultLabel, visible: true, descriptionZh: '', includeInAnalysis: false });
        for (const parentSlug of row.parentSlugs) children.set(parentSlug, (children.get(parentSlug) || 0) + 1);
      }
      rows.sort((a, b) => a.slug.localeCompare(b.slug, 'en')); loaded = true;
      applyTagSettings({ revision: data.revision, overrides: data.overrides, aliases: data.aliases }); renderRows();
    } catch (failure) {
      error.textContent = failure.message; error.hidden = false; retry.hidden = false;
      if (failure.status === 403) error.append(' ', button('账号', onAccount));
    } finally { busy = false; updateStatus(); }
  }
  async function saveChanges() {
    if (busy || !edits.size) return;
    const changes = [...edits].map(([slug, value]) => ({ slug, label: value.label.trim(), visible: value.visible, descriptionZh: (value.descriptionZh || '').replace(/\r\n?/g, '\n').trim(), includeInAnalysis: value.includeInAnalysis === true }));
    busy = true; error.hidden = true; updateStatus();
    try {
      let start = 0;
      while (start < changes.length) {
        const batch = []; let bytes = 100;
        while (start < changes.length && batch.length < 500) {
          const itemBytes = new TextEncoder().encode(JSON.stringify(changes[start])).length + 1;
          if (batch.length && bytes + itemBytes > 120 * 1024) break;
          batch.push(changes[start++]); bytes += itemBytes;
        }
        const result = await request({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, changes: batch }) });
        revision = result.revision;
        for (const change of batch) { base.set(change.slug, { label: change.label, visible: change.visible, descriptionZh: change.descriptionZh, includeInAnalysis: change.includeInAnalysis }); edits.delete(change.slug); }
        applyTagSettings(result);
      }
      renderRows();
    } catch (failure) { error.textContent = failure.message; error.hidden = false; retry.hidden = false; retry.textContent = failure.status === 409 ? '放弃修改并重新载入' : '重新载入'; renderRows(); }
    finally { busy = false; updateStatus(); }
  }
  search.addEventListener('input', () => { query = search.value; page = 0; renderRows(); });
  visibility.addEventListener('change', () => { filter = visibility.value; page = 0; renderRows(); });
  ordering.addEventListener('change', () => { order = ordering.value; page = 0; renderRows(); });
  const toolbar = el('div', 'tag-admin-toolbar'), title = el('div', 'tag-admin-title'); title.append(button('←', onBack, 'button button-quiet'), el('h1', '', '标签管理'));
  const actions = el('div', 'tag-admin-actions'); actions.append(status, reset, save); toolbar.append(title, actions);
  const filters = el('div', 'tag-admin-filters'); filters.append(search, visibility, ordering);
  const pager = el('div', 'tag-admin-pager'); pager.append(count, previous, next);
  container.replaceChildren(toolbar, filters, bulk, trail, error, retry, table, pager);
  function headerSize() { container.style.setProperty('--tag-admin-header-height', (document.querySelector('.app-header')?.getBoundingClientRect().height || 0) + 'px'); }
  window.addEventListener('resize', headerSize);
  return { async show() { headerSize(); if (!loaded) await load(); }, refresh: load };
}
