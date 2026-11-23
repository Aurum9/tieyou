import { getDeckProbabilityInputs } from './deck-probability-inputs.js';
import { openingLandStats, consecutiveLandProbabilities, mulliganLandStats, MULLIGAN_OPENING_HAND as OPENING_HAND } from './deck-probability.js';
import { classifyEarlyManaCard } from './deck-early-mana-cards.js';

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const estimatePercent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
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

function renderBars(list, rows, format = formatProbability) {
  list.replaceChildren(...rows.map(({ label, probability }) => {
    const row = el('li', 'deck-probability-row');
    const track = el('span', 'deck-probability-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = el('span', 'deck-analysis-bar-fill');
    fill.style.setProperty('--share', `${probability * 100}%`);
    track.append(fill);
    row.append(el('span', '', label), track, el('strong', '', format(probability)));
    return row;
  }));
}

function createEarlyManaSection(deck, cards, targets, unknownCount, signal) {
  const section = probabilityItem('前期加速');
  section.classList.add('deck-probability-early-mana');
  const metrics = el('div', 'deck-probability-early-mana-metrics');
  const setup = el('ul', 'deck-probability-bars');
  const available = el('ul', 'deck-probability-bars');
  for (const [label, list] of [['能启动加速', setup], ['当回合可用法术力', available]]) {
    const group = el('div');
    list.setAttribute('aria-label', label);
    group.append(el('h4', '', label), list);
    metrics.append(group);
  }
  const status = el('p', 'deck-analysis-note');
  status.setAttribute('role', 'status');
  const details = el('details', 'deck-analysis-note');
  const summary = el('summary');
  const excluded = el('p');
  details.append(summary, excluded);
  details.hidden = true;
  section.append(metrics, status, details);

  const byId = new Map(cards.map(card => [card.id, card]));
  const commanderColors = [...new Set(deck.entries.filter(entry => entry.zone === 'commander')
    .flatMap(entry => byId.get(entry.cardId)?.colorIdentity || []))];
  const profiles = new Map();
  let worker, timer;
  signal?.addEventListener('abort', () => { clearTimeout(timer); worker?.terminate(); }, { once: true });

  function refresh(handSize, drawFirstTurn, includeModalLands, mulligan) {
    if (signal?.aborted) return;
    clearTimeout(timer);
    worker?.terminate();
    worker = undefined;
    setup.replaceChildren();
    available.replaceChildren();
    metrics.hidden = true;
    details.hidden = true;
    status.textContent = handSize === null ? '' : '正在估算…';
    if (handSize === null) return;

    timer = setTimeout(() => {
      if (!section.isConnected) return;
      if (!profiles.has(includeModalLands)) {
        profiles.set(includeModalLands, targets.map(target => ({
          ...classifyEarlyManaCard(byId.get(target.id), { commanderColors, includeModalLands }),
          quantity: target.count,
          name: target.name,
        })));
      }
      const entries = profiles.get(includeModalLands);
      const partial = entries.filter(entry => entry.excluded?.land || entry.excluded?.ramp);
      details.hidden = !partial.length;
      summary.textContent = `${partial.reduce((sum, entry) => sum + entry.quantity, 0)} 张牌的效果未完整计入`;
      excluded.textContent = partial.map(entry => entry.name).join('、');
      const simulationDeck = entries.map(({ landOptions, ramp, quantity, earlyManaLand }) => ({
        landOptions, ramp, quantity, isLandForMulligan: Boolean(earlyManaLand),
      }));
      if (unknownCount) simulationDeck.push({ landOptions: [], ramp: null, quantity: unknownCount, isLandForMulligan: false });

      try {
        const current = new Worker(new URL('./deck-early-mana-worker.js', import.meta.url), { type: 'module' });
        worker = current;
        const finish = (data) => {
          if (worker !== current) return;
          current.terminate();
          worker = undefined;
          if (!data) {
            status.textContent = '加速概率估算失败';
            return;
          }
          renderBars(setup, data.turns.filter(({ setupProbability }) => Number.isFinite(setupProbability)).map(({ turn, setupProbability }) => ({
            label: `到第 ${turn} 回合`, probability: setupProbability,
          })), estimatePercent.format);
          renderBars(available, data.turns.map(({ turn, threshold, probability }) => ({
            label: `第 ${turn} 回合 · 可用 ≥${threshold} 费`, probability,
          })), estimatePercent.format);
          metrics.hidden = false;
          const limit = data.limitedTrials ? ` · ${data.limitedTrials.toLocaleString('zh-CN')} 局按已找到的出牌顺序保守估算` : '';
          status.textContent = `扣除加速费用后计算可用法术力 · ${data.trials.toLocaleString('zh-CN')} 局抽样${limit}`;
        };
        current.onmessage = event => finish(event.data);
        current.onerror = () => finish();
        current.postMessage({ cards: simulationDeck, options: { handSize, drawFirstTurn, mulligan } });
      } catch {
        worker?.terminate();
        worker = undefined;
        status.textContent = '加速概率估算失败';
      }
    }, 120);
  }
  return { section, refresh };
}

function createMulliganSettings() {
  const fields = el('fieldset', 'deck-probability-mulligan-settings');
  fields.append(el('legend', '', '调度策略'));
  const landField = el('fieldset', 'deck-probability-land-choices');
  landField.append(el('legend', '', '保留地牌张数'));
  const choices = Array.from({ length: 6 }, (_, index) => {
    const lands = index + 1;
    const choice = checkbox(`${lands} 张`, lands >= 2 && lands <= 4);
    landField.append(choice.field);
    return { lands, input: choice.input };
  });
  const minimum = el('select', 'deck-input');
  for (const size of [7, 6, 5]) {
    const option = el('option', '', `${size} 张`);
    option.value = String(size);
    minimum.append(option);
  }
  minimum.value = '6';
  const minimumField = el('label', 'deck-probability-hand-size');
  minimumField.append(el('span', '', '最低手牌'), minimum);
  const note = el('p', 'deck-analysis-note');
  note.setAttribute('role', 'status');
  fields.append(landField, minimumField, note);
  return { fields, choices, minimum, note };
}

function createMulliganResult() {
  const section = probabilityItem('调度后保留手牌');
  section.classList.add('deck-probability-mulligan-result');
  section.hidden = true;
  const expectation = output('平均地牌数');
  const metrics = el('div', 'deck-probability-mulligan-metrics');
  const handSizes = el('ul', 'deck-probability-bars');
  const lands = el('ul', 'deck-probability-bars');
  for (const [label, list] of [['保留手牌张数', handSizes], ['地牌张数分布', lands]]) {
    const group = el('div');
    list.setAttribute('aria-label', label);
    group.append(el('h4', '', label), list);
    metrics.append(group);
  }
  section.append(expectation.row, metrics);
  return { section, expectation, handSizes, lands };
}

function createLandComparison() {
  const table = el('table', 'deck-probability-comparison');
  table.setAttribute('aria-label', '连续下地概率比较');
  table.hidden = true;
  const head = el('thead');
  const row = el('tr');
  for (const label of ['回合', '无调度', '按调度策略']) {
    const cell = el('th', '', label);
    cell.scope = 'col';
    row.append(cell);
  }
  head.append(row);
  const body = el('tbody');
  table.append(head, body);
  return { table, body };
}

export function createDeckProbability(deck, cards, { signal, drawFirstTurn = true } = {}) {
  const { deckSize, landCount, modalLandCount, unknownCount, targets } = getDeckProbabilityInputs(deck, cards);
  const section = el('section', 'deck-analysis-card is-wide deck-probability');
  section.id = 'deck-probability';
  section.tabIndex = -1;
  const heading = el('div', 'deck-analysis-card-heading');
  const title = el('h2', '', '起手与法术力概率');
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
  const firstTurn = checkbox('首回合抓牌', drawFirstTurn);
  const modal = checkbox(`咒语／地双面牌也算地（${modalLandCount} 张）`, false);
  const strategy = checkbox('按调度策略', false);
  const mulliganSettings = createMulliganSettings();
  const settings = el('div', 'deck-probability-settings');
  settings.append(handField, firstTurn.field);
  if (modalLandCount) settings.append(modal.field);
  settings.append(strategy.field);

  const scope = el('p', 'deck-analysis-note');
  const opening = probabilityItem('无调度起手地牌');
  const expectation = output('平均地牌数');
  const distribution = el('ul', 'deck-probability-bars');
  distribution.setAttribute('aria-label', '无调度起手地牌张数分布');
  opening.append(expectation.row, distribution);

  const streak = probabilityItem('连续下地');
  const byTurn = el('ul', 'deck-probability-bars');
  byTurn.setAttribute('aria-label', '每回合连续下地概率');
  const comparison = createLandComparison();
  streak.append(el('p', 'deck-analysis-note', '从第 1 回合起每回合都下地'), byTurn, comparison.table);
  const mulliganResult = createMulliganResult();
  const earlyMana = createEarlyManaSection(deck, cards, targets, unknownCount, signal);

  function requestedHandSize() {
    if (strategy.input.checked) return OPENING_HAND;
    const size = Number(hand.value);
    return Number.isInteger(size) && size >= 1 && size <= MAX_HAND ? size : null;
  }

  let customHandSize = hand.value;
  function refresh() {
    const active = strategy.input.checked;
    mulliganSettings.fields.hidden = !active;
    mulliganSettings.fields.disabled = !active;
    const keepLandCounts = mulliganSettings.choices.filter(({ input }) => input.checked).map(({ lands }) => lands);
    const mulligan = active && keepLandCounts.length ? {
      keepLandCounts, minimumHandSize: Number(mulliganSettings.minimum.value),
    } : null;
    mulliganSettings.note.textContent = mulligan
      ? '首次调度免费 · 到最低手牌张数时保留'
      : '请选择至少一种保留地牌张数';
    mulliganResult.section.hidden = !mulligan;
    comparison.table.hidden = !mulligan;
    byTurn.hidden = Boolean(mulligan);
    const size = requestedHandSize();
    const drawFirstTurn = firstTurn.input.checked;
    earlyMana.refresh(active && !mulligan ? null : size, drawFirstTurn, modal.input.checked, mulligan);
    if (size === null) {
      scope.textContent = `起手张数需为 1–${MAX_HAND} 的整数。`;
      expectation.element.value = '—';
      distribution.replaceChildren();
      byTurn.replaceChildren();
      return;
    }
    const lands = landCount + (modal.input.checked ? modalLandCount : 0);
    const stats = openingLandStats(deckSize, lands, size);
    expectation.element.value = `${decimal.format(stats.expected)} 张`;
    const shortHand = stats.handSize < size ? ` · 实际抽 ${stats.handSize} 张` : '';
    scope.textContent = `牌库 ${deckSize} 张 · 地牌 ${lands} 张${shortHand} · 按自然抓牌计算`;
    renderBars(distribution, stats.distribution.map(({ lands, probability }) => ({ label: `${lands} 张`, probability })));
    const turns = consecutiveLandProbabilities(deckSize, lands, { handSize: size, drawFirstTurn });
    if (!mulligan) {
      renderBars(byTurn, turns.map(({ turn, probability }) => ({ label: `到第 ${turn} 回合`, probability })));
      return;
    }
    const kept = mulliganLandStats(deckSize, lands, { ...mulligan, drawFirstTurn });
    mulliganResult.expectation.element.value = `${decimal.format(kept.expected)} 张`;
    renderBars(mulliganResult.handSizes, kept.handSizes.map(({ handSize, probability }) => ({ label: `${handSize} 张`, probability })));
    renderBars(mulliganResult.lands, kept.distribution.map(({ lands, probability }) => ({ label: `${lands} 张`, probability })));
    comparison.body.replaceChildren(...turns.map(({ turn, probability }, index) => {
      const row = el('tr');
      const label = el('th', '', `第 ${turn} 回合`);
      label.scope = 'row';
      row.append(label, el('td', '', formatProbability(probability)), el('td', '', formatProbability(kept.turns[index].probability)));
      return row;
    }));
  }

  strategy.input.addEventListener('change', () => {
    if (strategy.input.checked) {
      customHandSize = hand.value;
      hand.value = String(OPENING_HAND);
    } else {
      hand.value = customHandSize;
    }
    hand.disabled = strategy.input.checked;
    refresh();
  });
  hand.addEventListener('input', refresh);
  firstTurn.input.addEventListener('change', refresh);
  modal.input.addEventListener('change', refresh);
  for (const { input } of mulliganSettings.choices) input.addEventListener('change', refresh);
  mulliganSettings.minimum.addEventListener('change', refresh);
  const grid = el('div', 'deck-probability-grid');
  grid.append(opening, streak, mulliganResult.section, earlyMana.section);
  section.append(settings, mulliganSettings.fields, scope);
  if (unknownCount) section.append(el('p', 'deck-analysis-note', `${unknownCount} 张主牌缺少卡牌数据，地牌概率按已识别的地牌计算。`));
  section.append(grid);
  refresh();
  return section;
}
