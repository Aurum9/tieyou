const demoSeenKey = 'tieyou.deck-guide-v2-seen';
let seenThisSession = false;

export function drawGuideMark(kind) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const path = document.createElementNS(ns, 'path');
  const arrow = kind === 'arrow';
  svg.setAttribute('class', arrow ? 'deck-guide-arrow' : 'deck-pencil-mark');
  svg.setAttribute('viewBox', arrow ? '0 0 72 36' : '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', arrow
    ? 'M14 4 C15 14 21 17 28 19 C34 21 37 25 36 31 M29 26 Q32 28 36 31 Q40 28 43 25'
    : 'M4 20l4.6-.9L20 7.7a1.4 1.4 0 0 0 0-2l-1.7-1.7a1.4 1.4 0 0 0-2 0L4.9 15.4 4 20z M14.6 5.7l3.7 3.7');
  svg.append(path);
  return svg;
}

function hasSeenDemo() {
  try { return seenThisSession || localStorage.getItem(demoSeenKey) === '1'; }
  catch { return seenThisSession; }
}

function rememberDemo() {
  seenThisSession = true;
  try { localStorage.setItem(demoSeenKey, '1'); }
  catch { /* Browsers may disable local storage. */ }
}


function element(tag, className, text) {
  const item = document.createElement(tag);
  item.className = className;
  if (text) item.textContent = text;
  return item;
}

export function createDeckDemo(container) {
  const view = container.ownerDocument?.defaultView;
  if (!view) return undefined;
  const motion = view.matchMedia('(prefers-reduced-motion: reduce)');
  let editor, replay, launchTimer, session;
  const labels = ['在这里搜索卡牌', '拖拽卡片放到对应区域', '也可以点击加号添加'];

  function detach() {
    clearTimeout(launchTimer);
    editor?.section.classList.remove('has-deck-demo', 'is-deck-demo');
    replay?.remove();
    replay = undefined;
    editor = undefined;
  }

  function stop(restoreFocus = false) {
    clearTimeout(launchTimer);
    const previous = session;
    if (!previous) return;
    session = undefined;
    previous.controller.abort();
    if (previous.typing) {
      previous.typing.input.value = previous.typing.value;
      previous.typing.input.classList.remove('deck-demo-typing');
    }
    previous.layer.remove();
    view.removeEventListener('scroll', previous.layout);
    view.removeEventListener('resize', previous.layout);
    editor?.section.classList.remove('is-deck-demo');
    if (restoreFocus) {
      // A completed tutorial can persist cards and replace its original launch button.
      (replay || editor?.query)?.focus({ preventScroll: true });
    }
  }

  function attach(next) {
    if (session && session.deckId !== next.deck.id) stop();
    editor = next;
    if (!next.target) { stop(); return; }
    if (session) next.section.classList.add('is-deck-demo');
    if (next.deck.entries.length) return;
    next.section.classList.add('has-deck-demo');
    replay = element('button', 'button button-quiet deck-demo-replay', '组牌演示');
    replay.type = 'button';
    replay.addEventListener('click', start);
    next.heading.after(replay);
    if (!session && !hasSeenDemo() && !next.query.value) {
      launchTimer = setTimeout(() => {
        if (view.tieyouAndroid && !view.navigator.onLine) return;
        if (!next.section.contains(document.activeElement) &&
          !container.querySelector('.deck-inline-form:not([hidden])') &&
          !document.querySelector('.deck-modal-overlay, dialog[open]')) start();
      }, 600);
    }
  }

  function wait(run, milliseconds) {
    return new Promise(resolve => {
      const signal = run.controller.signal;
      if (signal.aborted) { resolve(false); return; }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve(true);
      }, milliseconds);
      function cancel() { clearTimeout(timer); resolve(false); }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  function start() {
    if (session || !editor || editor.deck.entries.length || container.hidden) return;
    clearTimeout(launchTimer);
    rememberDemo();
    const layer = element('div', 'deck-demo-layer');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.setAttribute('aria-labelledby', 'deck-demo-caption');
    layer.innerHTML = '<svg class="deck-demo-mask" aria-hidden="true"><defs><mask id="deck-demo-cutout"><rect width="100%" height="100%" fill="white"/><g></g></mask></defs><rect width="100%" height="100%" fill="black" fill-opacity=".49" mask="url(#deck-demo-cutout)"/></svg>';
    const holes = layer.querySelector('g');
    const caption = element('p', '', labels[0]);
    caption.id = 'deck-demo-caption';
    caption.setAttribute('aria-live', 'polite');
    const stage = element('span', 'deck-demo-stage', '1 / 3');
    const next = element('button', 'button button-primary', '知道了');
    const skip = element('button', 'button button-quiet', '退出引导');
    next.type = skip.type = 'button';
    const controls = element('div', 'deck-demo-controls');
    controls.append(stage, skip, next);
    const panel = element('div', 'deck-demo-status');
    panel.append(caption, controls);
    layer.append(panel);
    document.body.append(layer);

    const run = {
      layer, stage, caption, next, skip, deckId: editor.deck.id, controller: new AbortController(), step: 0,
      layout() {
        const boxes = run.spots.map(item => item.getBoundingClientRect());
        holes.replaceChildren(...boxes.map(box => {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          for (const [name, value] of Object.entries({
            x: box.left - 4, y: box.top - 4, width: box.width + 8, height: box.height + 8, rx: 10, fill: 'black',
          })) rect.setAttribute(name, value);
          return rect;
        }));
        const atSearch = run.step > 0 && editor?.section.isConnected;
        panel.classList.toggle('is-search-anchored', Boolean(atSearch));
        const anchor = (atSearch ? editor.section.getBoundingClientRect() : boxes[0]) ||
          { left: 12, top: 12, bottom: 12 };
        const maxLeft = Math.max(10, view.innerWidth - panel.offsetWidth - 10);
        panel.style.left = Math.max(10, Math.min(anchor.left, maxLeft)) + 'px';
        const bottom = anchor.bottom + 12;
        const above = anchor.top - panel.offsetHeight - 12;
        const roomBelow = bottom + panel.offsetHeight <= view.innerHeight - 10;
        panel.style.top = Math.max(10, !atSearch && roomBelow ? bottom : above) + 'px';
        if (run.indicator) {
          const point = center(run.indicator.button);
          place(run.indicator.hand, { x: point.x + 7, y: point.y + 10 });
        }
      },
      spots: [],
    };
    session = run;
    editor.section.classList.add('is-deck-demo');
    view.addEventListener('scroll', run.layout, { passive: true });
    view.addEventListener('resize', run.layout);
    skip.addEventListener('click', () => stop(true));
    layer.addEventListener('wheel', event => event.preventDefault(), { passive: false });
    layer.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); stop(true); }
      if (event.key !== 'Tab') return;
      event.preventDefault();
      (next.disabled || document.activeElement === next ? skip : next).focus();
    });
    next.addEventListener('click', () => {
      if (run.failed) { stop(true); return; }
      if (run.step === 2) { stop(true); return; }
      run.step++;
      void perform(run);
    });
    skip.focus({ preventScroll: true });
    void perform(run);
  }

  function show(run, spots) {
    run.spots = spots;
    run.layout();
  }

  function center(item) {
    const box = item.getBoundingClientRect();
    return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
  }

  function frame(item, block = 'center') {
    item.scrollIntoView({ block, behavior: 'instant' });
  }

  function hand(run) {
    const cursor = element('div', 'deck-demo-hand');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML = '<svg viewBox="0 0 39 47"><path d="M12 26V7a3 3 0 0 1 6 0v13-4a3 3 0 0 1 6 0v5-2a3 3 0 0 1 6 0v5-1a3 3 0 0 1 6 0v8c0 7-4 12-11 12h-3c-4 0-8-3-10-6L5 27a3 3 0 0 1 4-4l3 3Z"/></svg>';
    run.layer.append(cursor);
    return cursor;
  }

  function place(cursor, { x, y }) {
    cursor.style.transform = `translate3d(${x - 15}px, ${y - 6}px, 0)`;
  }

  async function gesture(run, candidate, target) {
    // The real result supplies the drag visual as well as the registered drop source.
    const start = center(candidate.handle);
    const cursor = hand(run);
    place(cursor, start);
    if (!await wait(run, 500)) return;
    cursor.classList.add('is-pressed');
    if (!await wait(run, 750)) return;
    const end = center(target);
    const box = candidate.row.getBoundingClientRect();
    const dragged = candidate.row.cloneNode(true);
    dragged.classList.add('deck-demo-drag-copy');
    dragged.setAttribute('aria-hidden', 'true');
    dragged.inert = true;
    Object.assign(dragged.style, { left: box.left + 'px', top: box.top + 'px', width: box.width + 'px' });
    run.layer.insertBefore(dragged, cursor);
    candidate.row.classList.add('deck-demo-lifted');
    if (!motion.matches) {
      cursor.classList.add('is-moving');
      dragged.getBoundingClientRect();
      const travelX = Math.min(end.x - start.x, view.innerWidth - box.left - box.width * .82 - 8);
      dragged.style.transform = `translate3d(${travelX}px, ${end.y - start.y}px, 0) scale(.82)`;
    }
    place(cursor, end);
    if (!await wait(run, motion.matches ? 250 : 1200)) {
      candidate.row.classList.remove('deck-demo-lifted');
      return;
    }
    dragged.remove();
    candidate.row.classList.remove('deck-demo-lifted');
    cursor.classList.remove('is-pressed');
    if (!await wait(run, 380)) return;
    cursor.remove();
  }

  async function perform(run) {
    const { signal } = run.controller;
    run.next.disabled = true;
    run.skip.focus({ preventScroll: true });
    run.caption.textContent = labels[run.step];
    run.stage.textContent = `${run.step + 1} / 3`;
    try {
      if (run.step === 0) {
        frame(editor.section);
        show(run, [editor.section]);
        run.typing = { input: editor.query, value: editor.query.value };
        editor.query.value = '';
        editor.query.classList.add('deck-demo-typing');
        if (!await wait(run, 420)) return;
        editor.query.value = '加';
        if (!await wait(run, 280)) return;
        editor.query.classList.remove('deck-demo-typing');
        run.typing = undefined;
        await editor.submit('加速');
        if (signal.aborted) return;
        if (editor.candidates[0]?.card.name !== 'Sol Ring' || !editor.candidates[1]?.add.matches('.deck-candidate-add')) {
          throw new Error('演示搜索暂时无法载入。');
        }
        run.cardIds = editor.candidates.slice(0, 2).map(candidate => candidate.card.id);
        frame(editor.section);
        show(run, [editor.section]);
      } else {
        const candidate = editor.candidates.find(item => item.card.id === run.cardIds[run.step - 1]);
        if (!candidate?.add.matches('.deck-candidate-add')) throw new Error('演示卡牌暂时无法载入。');
        if (run.step === 2) {
          frame(candidate.add, 'nearest');
          run.indicator = { hand: hand(run), button: candidate.add };
          show(run, [candidate.add]);
          return;
        }
        const target = editor.target;
        frame(target, 'end');
        const overflow = target.getBoundingClientRect().bottom - view.innerHeight + 18;
        if (overflow > 0) view.scrollBy(0, overflow);
        show(run, [candidate.row, target]);
        await gesture(run, candidate, target);
        if (signal.aborted) return;
        const searchTop = editor.section.getBoundingClientRect().top;
        const added = await editor.drop(candidate, signal);
        if (signal.aborted) return;
        if (!added) throw new Error('演示卡牌暂时无法加入。');
        // A successful add renders the real deck board again. Refresh the search on the new controls.
        await editor.submit('加速');
        if (signal.aborted) return;
        if (!await wait(run, 230)) return;
        const boardTarget = editor.target;
        const saved = editor.deck.entries.find(item => item.cardId === candidate.card.id);
        const entry = saved && container.querySelector(`[data-entry-id="${saved.id}"]`);
        view.scrollBy(0, editor.section.getBoundingClientRect().top - searchTop);
        show(run, entry?.getClientRects().length ? [boardTarget, entry] : [boardTarget]);
      }
    } catch (error) {
      if (signal.aborted) return;
      run.failed = true;
      run.caption.textContent = error.message || '组牌引导暂时无法继续。';
      show(run, editor ? [editor.section] : []);
    } finally {
      editor?.query.classList.remove('deck-demo-typing');
      if (!signal.aborted) {
        run.next.disabled = false;
        run.next.focus({ preventScroll: true });
      }
    }
  }

  return { attach, detach, stop: () => stop(), dispose() { stop(); detach(); } };
}
