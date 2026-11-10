import { getDeckProbabilityInputs } from './deck-probability-inputs.js';
import { openingLandStats, openingHitProbability, consecutiveLandProbabilities } from './deck-probability.js';
import { normalizeText } from './search.js';

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const OPENING_HAND = 7;
const MAX_HAND = 20;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatProbability(probability) {
  if (probability > 0 && probability < 0.00005) return '<0.01%';
  if (probability < 1 && probability > 0.99995) return '>99.99%';
  return percent.format(probability);
}

function checkbox(label, checked) {
  const field = el('label', 'deck-check-label');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  field.append(input, el('span', '', label));
  return { field, input };
}

function probabilityItem(title) {
  const item = el('section', 'deck-probability-item');
  item.append(el('h3', '', title));
  return item;
}

function output(label) {
  const row = el('div', 'deck-probability-result');
  const value = el('output', '', '—');
  row.append(el('span', '', label), value);
  return { row, element: value };
}

function renderBars(list, rows) {
  list.replaceChildren(...rows.map(({ label, probability }) => {
    const row = el('li', 'deck-probability-row');
    const track = el('span', 'deck-probability-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'deck-analysis-bar-fill');
    fill.style.setProperty('--share', `${probability * 100}%`);
    track.append(fill);
    row.append(el('span', '', label), track, el('strong', '', formatProbability(probability)));
    return row;
  }));
}

function createTargetPicker(targets, onChange) {
  const section = probabilityItem('起手命中');
  const result = output('至少抓到一张已选牌');
  const query = el('input', 'deck-input deck-probability-target-query');
  query.type = 'search';
  query.placeholder = '搜索主牌';
  query.setAttribute('aria-label', '搜索起手目标牌');
  const chips = el('div', 'deck-probability-selected');
  const list = el('div', 'deck-probability-target-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', '起手目标牌');
  const selected = new Set();
  const lookup = targets.map(target => ({
    ...target, search: [target.name, ...target.aliases].map(normalizeText),
  }));

  function update() {
    const chosen = lookup.filter(target => selected.has(target.id));
    chips.replaceChildren(...chosen.map(target => {
      const remove = el('button', 'button button-quiet', `${target.name} ×`);
      remove.type = 'button';
      remove.setAttribute('aria-label', `取消选择 ${target.name}`);
      remove.addEventListener('click', () => {
        selected.delete(target.id);
        renderList();
        update();
        query.focus();
      });
      return remove;
    }));
    chips.hidden = chosen.length === 0;
    onChange(chosen.reduce((sum, target) => sum + target.count, 0), result.element);
  }

  function renderList() {
    const term = normalizeText(query.value || '');
    const matches = lookup.filter(target => target.search.some(text => text.includes(term)));
    if (!matches.length) {
      list.replaceChildren(el('p', 'deck-analysis-empty', '没有匹配的主牌'));
      return;
    }
    list.replaceChildren(...matches.map(target => {
      const control = checkbox(target.name, selected.has(target.id));
      control.field.classList.add('deck-probability-target');
      control.field.append(el('small', '', `×${target.count}`));
      control.input.setAttribute('aria-label', target.name);
      control.input.addEventListener('change', () => {
        if (control.input.checked) selected.add(target.id);
        else selected.delete(target.id);
        update();
      });
      return control.field;
    }));
  }

  query.addEventListener('input', renderList);
  renderList();
  chips.hidden = true;
  section.append(result.row, query, chips, list);
  return section;
}

export function createDeckProbability(deck, cards) {
  const { deckSize, landCount, modalLandCount, unknownCount, targets } = getDeckProbabilityInputs(deck, cards);
  const section = el('section', 'deck-analysis-card is-wide deck-probability');
  section.id = 'deck-probability';
  section.tabIndex = -1;
  const heading = el('div', 'deck-analysis-card-heading');
  const title = el('h2', '', '起手与下地概率');
  title.id = 'deck-probability-heading';
  heading.append(title);
  section.setAttribute('aria-labelledby', title.id);
  section.append(heading);
  if (!deckSize) {
    section.append(el('p', 'deck-analysis-empty', '加入主牌后可计算概率'));
    return section;
  }

  const hand = el('input', 'deck-input');
  hand.type = 'number';
  hand.min = '1';
  hand.max = String(MAX_HAND);
  hand.step = '1';
  hand.value = String(OPENING_HAND);
  const handField = el('label', 'deck-probability-hand-size');
  handField.append(el('span', '', '起手张数'), hand);
  const firstTurn = checkbox('首回合抓牌', true);
  const modal = checkbox(`咒语／地双面牌也算地（${modalLandCount} 张）`, false);
  const settings = el('div', 'deck-probability-settings');
  settings.append(handField, firstTurn.field);
  if (modalLandCount) settings.append(modal.field);

  const scope = el('p', 'deck-analysis-note');
  const opening = probabilityItem('起手地牌');
  const expectation = output('平均地牌数');
  const distribution = el('ul', 'deck-probability-bars');
  distribution.setAttribute('aria-label', '起手地牌张数分布');
  opening.append(expectation.row, distribution);

  const streak = probabilityItem('连续下地');
  const byTurn = el('ul', 'deck-probability-bars');
  byTurn.setAttribute('aria-label', '每回合连续下地概率');
  streak.append(el('p', 'deck-analysis-note', '从第 1 回合起每回合都下地'), byTurn);

  function requestedHandSize() {
    const size = Number(hand.value);
    return Number.isInteger(size) && size >= 1 && size <= MAX_HAND ? size : null;
  }
  let selectedCopies = 0, hitOutput;
  function updateHit() {
    const size = requestedHandSize();
    if (!hitOutput) return;
    hitOutput.value = size && selectedCopies ? formatProbability(openingHitProbability(deckSize, selectedCopies, size)) : '—';
  }
  const picker = createTargetPicker(targets, (copies, node) => {
    selectedCopies = copies;
    hitOutput = node;
    updateHit();
  });

  function refresh() {
    const size = requestedHandSize();
    if (size === null) {
      scope.textContent = `起手张数需为 1–${MAX_HAND} 的整数。`;
      expectation.element.value = '—';
      distribution.replaceChildren();
      byTurn.replaceChildren();
      updateHit();
      return;
    }
    const lands = landCount + (modal.input.checked ? modalLandCount : 0);
    const stats = openingLandStats(deckSize, lands, size);
    expectation.element.value = `${decimal.format(stats.expected)} 张`;
    const shortHand = stats.handSize < size ? ` · 实际抽 ${stats.handSize} 张` : '';
    scope.textContent = `牌库 ${deckSize} 张 · 地牌 ${lands} 张${shortHand} · 无调度，按自然抓牌计算`;
    renderBars(distribution, stats.distribution.map(({ lands, probability }) => ({ label: `${lands} 张`, probability })));
    const turns = consecutiveLandProbabilities(deckSize, lands, { handSize: size, drawFirstTurn: firstTurn.input.checked });
    renderBars(byTurn, turns.map(({ turn, probability }) => ({ label: `到第 ${turn} 回合`, probability })));
    updateHit();
  }

  hand.addEventListener('input', refresh);
  firstTurn.input.addEventListener('change', refresh);
  modal.input.addEventListener('change', refresh);
  const grid = el('div', 'deck-probability-grid');
  grid.append(opening, picker, streak);
  section.append(settings, scope);
  if (unknownCount) section.append(el('p', 'deck-analysis-note', `${unknownCount} 张主牌缺少卡牌数据，地牌概率按已识别的地牌计算。`));
  section.append(grid);
  refresh();
  return section;
}
