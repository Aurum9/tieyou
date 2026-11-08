let catalogRequest;

function tokenCatalog() {
  catalogRequest ??= fetch('/data/playtest-tokens.json').then(async response => {
    if (!response.ok) throw new Error('衍生物牌库加载失败');
    const data = await response.json();
    if (data.version !== 1 || !data.tokens || !data.byCard) throw new Error('衍生物牌库格式无效');
    return data;
  }).catch(error => {
    catalogRequest = undefined;
    throw error;
  });
  return catalogRequest;
}

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function linkedTokens(catalog, cardIds) {
  return [...new Set(cardIds.flatMap(id => catalog.byCard[id] || []))]
    .map(id => catalog.tokens[id]).filter(Boolean);
}

function tokenLabel(token) {
  const name = token.zhName || token.name;
  return /\bCreature\b/.test(token.typeLine.split('—')[0]) && token.power && token.toughness
    ? `${token.power}/${token.toughness} ${name}` : name;
}

export function createTokenPicker(state, onSpawn) {
  const form = el('form', 'pt-token-picker');
  const label = el('label', 'pt-field');
  const select = el('select', 'pt-input');
  select.setAttribute('aria-label', '选择衍生物');
  const placeholder = el('option', '', '正在加载衍生物…');
  placeholder.value = '';
  select.append(placeholder);
  select.disabled = true;
  label.append(el('span', '', '衍生物'), select);

  const quick = el('div', 'pt-token-quick');
  const quantity = el('input', 'pt-input');
  quantity.type = 'number';
  quantity.min = 1;
  quantity.max = 50;
  quantity.step = 1;
  quantity.value = '1';
  quantity.required = true;
  quantity.setAttribute('aria-label', '衍生物数量');
  const quantityLabel = el('label', 'pt-field');
  quantityLabel.append(el('span', '', '数量'), quantity);
  const submit = el('button', 'button button-primary', '派出');
  submit.type = 'submit';
  submit.disabled = true;
  const actions = el('div', 'pt-token-submit');
  actions.append(quantityLabel, submit);
  form.append(label, quick, actions);

  tokenCatalog().then(catalog => {
    if (!form.isConnected) return;
    const deckTokens = linkedTokens(catalog, state.deck.entries.map(entry => entry.cardId));
    const options = new Map(deckTokens.map(token => [token.id, token]));
    const labels = new Map();
    for (const token of deckTokens) {
      const name = tokenLabel(token);
      labels.set(name, (labels.get(name) || 0) + 1);
    }
    placeholder.textContent = options.size ? '选择衍生物' : '这副套牌暂无关联衍生物';
    select.disabled = !options.size;
    for (const token of deckTokens) {
      const name = tokenLabel(token);
      const rule = (token.zhText || token.oracleText || '').split('\n')[0].trim();
      const details = [token.colors?.join(''), rule.length > 32 ? `${rule.slice(0, 31)}…` : rule].filter(Boolean);
      const option = el('option', '', labels.get(name) > 1 && details.length ? `${name} · ${details.join(' · ')}` : name);
      option.value = token.id;
      select.append(option);
    }

    const recentCards = ['battlefield', 'hand', 'graveyard']
      .flatMap(zone => state.zones[zone].map(id => state.pieces[id].cardId)).filter(Boolean);
    const shortcuts = linkedTokens(catalog, recentCards).filter(token => options.has(token.id)).slice(0, 15);
    const update = () => {
      submit.disabled = !options.has(select.value);
      for (const control of quick.children) control.setAttribute('aria-pressed', String(control.value === select.value));
    };
    for (const token of shortcuts) {
      const control = el('button', 'button button-quiet', tokenLabel(token));
      control.type = 'button';
      control.value = token.id;
      control.title = token.zhText || token.oracleText || '';
      control.addEventListener('click', () => { select.value = token.id; update(); });
      quick.append(control);
    }
    select.addEventListener('change', update);
    update();
    form.addEventListener('submit', event => {
      event.preventDefault();
      const token = options.get(select.value);
      if (token) onSpawn(token, Number(quantity.value));
    });
  }).catch(() => { placeholder.textContent = '衍生物牌库加载失败'; });
  return form;
}
