import { analyzeDeckMana } from './deck-analysis.js';
import { analyzeDeckRelated, loadTagVocabulary, loadTokenCatalog } from './deck-analysis-related.js';
import { getVersion } from './decks.js';
import { createDeckProbability } from './deck-probability-ui.js';
import { appendManaText } from './mana-symbols.js';

const COLOR_LABELS = { W: '白色', U: '蓝色', B: '黑色', R: '红色', G: '绿色', M: '多色', C: '无色' };
const LAND_LABELS = {
  direct: '直接产费地', conditional: '条件产费地', fetch: '找地地',
  modal: '地／咒语双面牌', other: '其他地牌', accelerators: '非地加速',
};
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, className = 'button button-quiet') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function panel(title, wide = false) {
  const section = el('section', `deck-analysis-card${wide ? ' is-wide' : ''}`);
  const heading = el('div', 'deck-analysis-card-heading');
  heading.append(el('h2', '', title));
  section.append(heading);
  return { section, heading };
}

function drilldown(id, entries, cards, onInspect) {
  const region = el('div', 'deck-analysis-drilldown');
  region.id = id;
  region.hidden = true;
  let selected;
  function clear() {
    selected?.setAttribute('aria-pressed', 'false');
    selected = null;
    region.hidden = true;
  }
  function show(control, title, entryIds, rules = '') {
    if (selected === control) { clear(); return; }
    clear();
    selected = control;
    control.setAttribute('aria-pressed', 'true');
    const list = el('ul', 'deck-analysis-card-list');
    for (const id of entryIds) {
      const entry = entries.get(id), card = cards.get(entry?.cardId);
      if (!card) continue;
      const row = el('li');
      const name = card.zhName || card.name;
      const inspect = button('', () => onInspect(card, getVersion(card, entry.versionId)), 'deck-analysis-entry');
      inspect.append(el('span', '', name), el('span', 'deck-analysis-entry-count', `×${entry.quantity}${entry.zone === 'commander' ? ' · 统帅' : ''}`));
      row.append(inspect);
      list.append(row);
    }
    region.replaceChildren(el('h3', '', title));
    if (rules) region.append(appendManaText(el('p', 'deck-analysis-token-rules rule-text'), rules));
    region.append(list);
    region.hidden = false;
    region.scrollIntoView?.({ block: 'nearest' });
  }
  function select(control, title, ids, rules) {
    control.setAttribute('aria-controls', id);
    control.setAttribute('aria-pressed', 'false');
    control.addEventListener('click', () => show(control, title, ids, rules));
  }
  return { region, clear, select };
}

function colorSwatch(key) {
  const swatch = el('span', 'deck-analysis-swatch');
  swatch.setAttribute('data-mana', key);
  swatch.setAttribute('aria-hidden', 'true');
  return swatch;
}

function renderCurve(stats, details) {
  const { section, heading } = panel('法术力曲线', true);
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.checked = true;
  const label = el('label', 'deck-check-label');
  label.append(toggle, el('span', '', '按颜色拆分'));
  heading.append(label);
  const chart = el('div', 'deck-analysis-curve');
  const legend = el('div', 'deck-analysis-legend');
  const max = Math.max(1, ...stats.curve.bins.map(bin => bin.count));
  function refresh() {
    details.clear();
    const colored = toggle.checked;
    const bins = stats.curve.bins.map(bin => {
      const control = el('button', 'deck-analysis-bin');
      control.type = 'button';
      control.disabled = bin.count === 0;
      const breakdown = bin.colors.filter(color => color.count > 0);
      const colors = colored ? breakdown : [{ key: '', count: bin.count }];
      const track = el('span', 'deck-analysis-bin-track');
      for (const color of colors) {
        const segment = el('span', 'deck-analysis-segment');
        if (color.key) {
          segment.setAttribute('data-mana', color.key);
          segment.title = `${COLOR_LABELS[color.key]} ${color.count} 张`;
        }
        segment.style.setProperty('--share', `${color.count / max * 100}%`);
        track.append(segment);
      }
      const title = `法术力值 ${bin.key} · ${bin.count} 张`;
      const descriptions = colored ? breakdown.map(color => `${COLOR_LABELS[color.key]} ${color.count} 张`) : [];
      control.setAttribute('aria-label', [title, ...descriptions].join('，'));
      control.append(el('strong', 'deck-analysis-bin-count', bin.count), track, el('span', 'deck-analysis-bin-label', bin.key));
      details.select(control, title, bin.entryIds);
      return control;
    });
    chart.replaceChildren(...bins);
    legend.hidden = !colored;
  }
  for (const color of stats.curve.colors) {
    const control = el('button', 'deck-analysis-legend-item');
    control.type = 'button';
    control.disabled = color.count === 0;
    const title = `${COLOR_LABELS[color.key]} ${color.count} 张`;
    control.append(colorSwatch(color.key), el('span', '', title));
    details.select(control, title, color.entryIds);
    legend.append(control);
  }
  toggle.addEventListener('change', refresh);
  refresh();
  section.append(chart, legend, el('p', 'deck-analysis-note', '曲线统计非地牌。多色牌计入多色组。'), details.region);
  return section;
}

function renderBars(list, rows, details, { unit = '张', colors = false } = {}) {
  const max = Math.max(1, ...rows.map(row => row.count));
  list.replaceChildren(...rows.map(row => {
    const control = el('button', 'deck-analysis-bar');
    control.type = 'button';
    if (row.description) control.title = row.description;
    control.disabled = row.count === 0;
    const label = el('span', 'deck-analysis-bar-label');
    if (colors) label.append(colorSwatch(row.key));
    label.append(el('span', '', row.label));
    if (row.slug && row.slug !== row.label) label.append(el('small', 'deck-analysis-tag-slug', row.slug));
    const track = el('span', 'deck-analysis-bar-track');
    const fill = el('span', 'deck-analysis-bar-fill');
    if (colors) fill.setAttribute('data-mana', row.key);
    fill.style.setProperty('--share', `${row.count / max * 100}%`);
    track.append(fill);
    const title = `${row.label} · ${row.count} ${unit}`;
    control.setAttribute('aria-label', row.slug && row.slug !== row.label ? `${title}（${row.slug}）` : title);
    control.append(label, track, el('strong', 'deck-analysis-bar-count', row.count));
    details.select(control, title, row.entryIds, row.description);
    return control;
  }));
}

function coloredPanel(title, rows, details, note, unit) {
  const { section } = panel(title);
  const chart = el('div', 'deck-analysis-bars');
  renderBars(chart, rows.map(row => ({ ...row, label: COLOR_LABELS[row.key] })), details, { unit, colors: true });
  section.append(chart, el('p', 'deck-analysis-note', note), details.region);
  return section;
}

function renderSources(lands, details) {
  const { section } = panel('地牌与加速分类', true);
  const chart = el('div', 'deck-analysis-bars');
  const rows = Object.entries(LAND_LABELS).map(([key, label]) => ({ ...lands[key], label }));
  renderBars(chart, rows, details);
  section.append(chart, el('p', 'deck-analysis-note', '一张地牌可以同时属于多个分类。'), details.region);
  return section;
}

function renderComposition(parent, groups, makeDetails) {
  const list=el('div','deck-composition');
  const max=Math.max(1,...groups.map(group=>group.count));
  function renderGroup(group, path, nested=false) {
    const disclosure=el('details','deck-composition-group'+(nested?' is-nested':''));
    disclosure.dataset.role=group.slug;
    const summary=el('summary','deck-composition-summary');
    const label=el('span','deck-composition-label',group.label);
    const track=el('span','deck-analysis-bar-track'),fill=el('span','deck-analysis-bar-fill');
    fill.style.setProperty('--share',`${group.count/max*100}%`);track.append(fill);
    summary.append(label,track,el('strong','',group.count));disclosure.append(summary);
    const content=el('div','deck-composition-content'),detail=makeDetails(path),rows=el('div','deck-analysis-bars');
    const choices=[{label:'全部',count:group.count,entryIds:group.entryIds}];
    if(group.repeatable?.count) choices.push({label:'其中可重复',...group.repeatable});
    for(const child of group.children.filter(child=>child.count>0 && !child.children.length))choices.push({...child,slug:undefined});
    renderBars(rows,choices,detail);content.append(rows);
    for(const child of group.children.filter(child=>child.count>0 && child.children.length))content.append(renderGroup(child,path+'-'+child.slug,true));
    content.append(detail.region);disclosure.append(content);return disclosure;
  }
  for(const group of groups)list.append(renderGroup(group,'composition-'+group.slug));
  parent.replaceChildren(list);
}

function renderTokens(parent, tokens, details) {
  if (!tokens.length) { parent.replaceChildren(el('p', 'deck-analysis-empty', '这副卡组暂无关联衍生物')); return; }
  const list = el('ul', 'deck-analysis-token-list');
  for (const { label, count, token, entryIds } of tokens) {
    const item = el('li');
    const control = el('button', 'deck-analysis-token');
    control.type = 'button';
    if (token.image && /^https?:\/\//i.test(token.image)) {
      const image = el('img', 'deck-analysis-token-image');
      image.src = token.image;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      control.append(image);
    }
    const text = el('span', 'deck-analysis-token-label');
    text.append(el('strong', '', label), el('small', '', `${count} 张关联牌`));
    control.append(text);
    const rules = (token.faces?.length ? token.faces : [token])
      .map(face => face.zhText || face.oracleText).filter(Boolean).join('\n\n');
    details.select(control, label, entryIds, rules);
    item.append(control);
    list.append(item);
  }
  parent.replaceChildren(list, details.region);
}

function loadSection(parent, load, render) {
  const status = el('p', 'deck-analysis-note', '正在加载…');
  status.setAttribute('role', 'status');
  parent.replaceChildren(status);
  load().then(data => {
    if (parent.isConnected) render(data);
  }).catch(() => {
    if (!parent.isConnected) return;
    status.textContent = '加载失败';
    parent.append(button('重试', () => loadSection(parent, load, render)));
  });
}

export function createDeckAnalysis({ deck, cards, onBack, onInspect }) {
  const stats = analyzeDeckMana(deck, cards);
  const cardIndex = new Map(cards.map(card => [card.id, card]));
  const entries = new Map(deck.entries.map(entry => [entry.id, entry]));
  const details = key => drilldown(`deck-analysis-${key}-details`, entries, cardIndex, onInspect);
  const root = el('section', 'deck-analysis');
  const heading = el('header', 'deck-analysis-heading');
  const title = el('div');
  title.append(el('h1', '', '卡组分析'), el('p', 'deck-analysis-note', `${deck.name} · 主牌 ${stats.counts.main} 张 · 统帅 ${stats.counts.commander} 张`));
  const probability = createDeckProbability(deck, cards);
  const actions = el('div', 'deck-actions');
  actions.append(button('查看概率 ↓', () => {
    probability.focus({ preventScroll: true });
    probability.scrollIntoView({ block: 'start' });
  }), button('← 返回牌表', onBack));
  heading.append(title, actions);
  const kpis = el('div', 'deck-analysis-kpis');
  for (const [label, value] of [
    ['地牌', stats.counts.lands],
    ['非地牌', stats.counts.spells],
    ['法术力值总和', stats.curve.totalManaValue],
    ['平均法术力值', stats.curve.averageManaValue],
  ]) {
    const kpi = el('div', 'deck-analysis-kpi');
    kpi.append(el('span', '', label), el('strong', '', value == null ? '—' : format.format(value)));
    kpis.append(kpi);
  }
  const grid = el('div', 'deck-analysis-grid');
  grid.append(
    renderCurve(stats, details('curve')),
    coloredPanel('费用色符需求', stats.demand, details('demand'), '混血符号按其中的色符分别计数。', '个色符'),
    coloredPanel('地牌产色', stats.lands.colors, details('land-colors'), '统计直接产费地。同一张多色地可以计入多个颜色。', '张'),
    renderSources(stats.lands, details('sources')),
  );
  const tags = panel('套牌构成', true), tokens = panel('关联衍生物', true);
  const tagBody = el('div'), tokenBody = el('div');
  tags.section.append(tagBody);
  tokens.section.append(tokenBody);
  grid.prepend(tags.section);
  grid.append(tokens.section, probability);
  root.append(heading, kpis);
  if (stats.counts.unknown) root.append(el('p', 'deck-analysis-note', `${stats.counts.unknown} 张牌缺少卡牌数据。`));
  root.append(grid);
  if (stats.counts.main + stats.counts.commander === 0) {
    loadSection(tagBody, loadTagVocabulary, tagVocabulary => {
      const { composition }=analyzeDeckRelated(deck,cards,{tagVocabulary});
      renderComposition(tagBody,composition,details);
    });
    renderTokens(tokenBody, []);
  } else {
    loadSection(tagBody, loadTagVocabulary, tagVocabulary => {
      const { composition, tags: selectedTags } = analyzeDeckRelated(deck, cards, { tagVocabulary });
      const grouped=new Set(composition.map(group=>group.slug));
      const extra=selectedTags.filter(tag=>!grouped.has(tag.slug) && !tag.slug.startsWith('repeatable-')).map(tag=>({...tag,children:[]}));
      renderComposition(tagBody, [...composition,...extra], details);
    });
    loadSection(tokenBody, loadTokenCatalog, tokenCatalog => {
      const { tokens } = analyzeDeckRelated(deck, cards, { tokenCatalog });
      renderTokens(tokenBody, tokens, details('tokens'));
    });
  }
  return root;
}
