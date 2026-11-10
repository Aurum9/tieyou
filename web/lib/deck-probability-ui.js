import { getDeckProbabilityInputs } from './deck-probability-inputs.js';
import { openingLandStats, openingHitProbability, consecutiveLandProbabilities } from './deck-probability.js';
import { classifyEarlyManaCard } from './deck-early-mana-cards.js';
import { normalizeText } from './search.js';

const percent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2 });
const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const estimatePercent = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 });
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

function createEarlyManaSection(deck, cards, targets, unknownCount) {
  const section = probabilityItem('前两回合加速');
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

  function refresh(handSize, drawFirstTurn, includeModalLands) {
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
      const simulationDeck = entries.map(({ landOptions, ramp, quantity }) => ({ landOptions, ramp, quantity }));
      if (unknownCount) simulationDeck.push({ landOptions: [], ramp: null, quantity: unknownCount });

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
          renderBars(setup, data.turns.map(({ turn, setupProbability }) => ({
            label: `到第 ${turn} 回合`, probability: setupProbability,
          })), estimatePercent.format);
          renderBars(available, data.turns.map(({ turn, threshold, probability }) => ({
            label: `第 ${turn} 回合 · 可用 ≥${threshold} 费`, probability,
          })), estimatePercent.format);
          metrics.hidden = false;
          status.textContent = `扣除加速费用后计算可用法术力 · ${data.trials.toLocaleString('zh-CN')} 局抽样`;
        };
        current.onmessage = event => finish(event.data);
        current.onerror = () => finish();
        current.postMessage({ cards: simulationDeck, options: { handSize, drawFirstTurn } });
      } catch {
        worker?.terminate();
        worker = undefined;
        status.textContent = '加速概率估算失败';
      }
    }, 120);
  }
  return { section, refresh };
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
  const earlyMana = createEarlyManaSection(deck, cards, targets, unknownCount);

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
    earlyMana.refresh(size, firstTurn.input.checked, modal.input.checked);
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
  grid.append(opening, picker, streak, earlyMana.section);
  section.append(settings, scope);
  if (unknownCount) section.append(el('p', 'deck-analysis-note', `${unknownCount} 张主牌缺少卡牌数据，地牌概率按已识别的地牌计算。`));
  section.append(grid);
  refresh();
  return section;
}
