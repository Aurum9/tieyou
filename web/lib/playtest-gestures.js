const DRAG_THRESHOLD = 9;
const HOLD_DELAY = 550;

/** Bind card gestures. The horizontal axis preserves a swipeable hand row. */
export function attachCardGestures(element, { id, zone, axis = 'free', onDrop = () => {}, onMenu = () => {} }) {
  const doc = element.ownerDocument || globalThis.document;
  const view = doc?.defaultView || globalThis.window;
  let active = null, ghost = null, dropTarget = null, frame = null, suppressClick = false, destroyed = false;
  const previousTouchAction = element.style?.touchAction;
  const previousCallout = element.style?.webkitTouchCallout;
  if (element.style) { element.style.touchAction = 'none'; element.style.webkitTouchCallout = 'none'; }

  function ignored(event) { return Boolean(event.target?.closest?.('.pt-card-menu, [data-gesture-ignore]')); }
  function listen(type, handler, options) { doc?.addEventListener?.(type, handler, options); }
  function unlisten(type, handler, options) { doc?.removeEventListener?.(type, handler, options); }
  function capture() { try { element.setPointerCapture?.(active.pointerId); active.captured = true; } catch { /* The pointer may already have ended. */ } }
  function clearHold() { if (active?.timer !== undefined) { clearTimeout(active.timer); active.timer = undefined; } }
  function clearTarget() { dropTarget?.classList?.remove('pt-drop-active'); dropTarget = null; }
  function targetAt(x, y) {
    const width = view?.innerWidth || doc?.documentElement?.clientWidth;
    const height = view?.innerHeight || doc?.documentElement?.clientHeight;
    if (x < 0 || y < 0 || (width && x >= width) || (height && y >= height)) return null;
    const target = doc?.elementFromPoint?.(x, y)?.closest?.('[data-drop-zone]');
    const destination = target?.dataset?.dropZone || target?.getAttribute?.('data-drop-zone');
    return destination && destination !== zone ? target : null;
  }
  function updateTarget() {
    const next = targetAt(active.x, active.y);
    if (next === dropTarget) return;
    clearTarget(); dropTarget = next; dropTarget?.classList?.add('pt-drop-active');
  }
  function moveGhost() { if (ghost?.style) ghost.style.transform = `translate3d(${active.x - active.offsetX}px, ${active.y - active.offsetY}px, 0)`; }
  function edgeSpeed(position, start, end, margin = 44) {
    if (position < start + margin) return -Math.ceil(14 * Math.max(0, (start + margin - position) / margin));
    if (position > end - margin) return Math.ceil(14 * Math.max(0, (position - end + margin) / margin));
    return 0;
  }
  function autoScroll() {
    frame = null;
    if (active?.mode !== 'drag') return;
    if (active.x >= 0 && active.y >= 0 && active.x < view?.innerWidth && active.y < view?.innerHeight) {
      const vertical = edgeSpeed(active.y, 0, view.innerHeight);
      if (vertical) view.scrollBy?.(0, vertical);
      const host = doc?.elementFromPoint?.(active.x, active.y)?.closest?.('[data-hand-scroll]');
      if (host) {
        const rect = host.getBoundingClientRect();
        if (active.y >= rect.top && active.y <= rect.bottom) host.scrollLeft += edgeSpeed(active.x, rect.left, rect.right, 32);
      }
      updateTarget();
    }
    if (view?.requestAnimationFrame) frame = view.requestAnimationFrame(autoScroll);
  }
  function startDrag() {
    active.mode = 'drag'; clearHold(); capture(); suppressClick = true;
    element.classList?.remove('pt-card-held'); element.classList?.add('pt-card-dragging'); doc?.body?.classList?.add('pt-drag-active');
    const rect = element.getBoundingClientRect?.() || { left: active.startX, top: active.startY, width: 110, height: 154 };
    active.offsetX = element.classList?.contains?.('pt-card-board')
      ? active.startX - rect.left
      : Math.min(Math.max(0, active.startX - rect.left), rect.width);
    active.offsetY = Math.min(Math.max(0, active.startY - rect.top), rect.height);
    ghost = element.cloneNode?.(true) || null;
    if (ghost) {
      ghost.classList?.remove('pt-card-held', 'pt-card-dragging'); ghost.classList?.add('pt-drag-ghost');
      ghost.setAttribute?.('aria-hidden', 'true'); ghost.inert = true; ghost.removeAttribute?.('id');
      for (const child of ghost.querySelectorAll?.('[id]') || []) child.removeAttribute('id');
      if (ghost.style) Object.assign(ghost.style, { position: 'fixed', left: '0', top: '0', width: `${rect.width}px`, height: `${rect.height}px`, margin: '0', pointerEvents: 'none', zIndex: '10000' });
      doc?.body?.append?.(ghost); moveGhost();
    }
    updateTarget();
    if (view?.requestAnimationFrame) frame = view.requestAnimationFrame(autoScroll);
  }
  function finish() {
    if (!active) return;
    clearHold();
    if (frame !== null) { view?.cancelAnimationFrame?.(frame); frame = null; }
    if (active.captured) { try { element.releasePointerCapture?.(active.pointerId); } catch { /* Capture may have been released by the browser. */ } }
    element.classList?.remove('pt-card-held', 'pt-card-dragging'); doc?.body?.classList?.remove('pt-drag-active');
    ghost?.remove?.(); ghost = null; clearTarget(); active = null;
    unlisten('pointermove', pointerMove); unlisten('pointerup', pointerUp); unlisten('pointercancel', pointerCancel); unlisten('keydown', keyDown);
  }
  function pointerDown(event) {
    if (destroyed || active || event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return;
    suppressClick = false;
    if (ignored(event)) return;
    active = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, mode: 'pending', touch: event.pointerType !== 'mouse', held: false, captured: false, hand: element.closest?.('[data-hand-scroll]') || null };
    active.startScroll = active.hand?.scrollLeft || 0;
    active.timer = setTimeout(() => { if (active?.mode === 'pending') { active.held = true; element.classList?.add('pt-card-held'); } }, HOLD_DELAY);
    listen('pointermove', pointerMove, { passive: false }); listen('pointerup', pointerUp); listen('pointercancel', pointerCancel); listen('keydown', keyDown);
  }
  function pointerMove(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    active.x = event.clientX; active.y = event.clientY;
    const dx = active.x - active.startX, dy = active.y - active.startY;
    if (active.mode === 'pending' && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      if (axis === 'horizontal' && active.touch && !active.held && Math.abs(dx) > Math.abs(dy)) {
        active.mode = 'scroll'; clearHold(); capture(); suppressClick = true;
      } else startDrag();
    }
    if (active.mode === 'scroll') { if (active.hand) active.hand.scrollLeft = active.startScroll - dx; event.preventDefault(); }
    else if (active.mode === 'drag') { event.preventDefault(); moveGhost(); updateTarget(); }
  }
  function pointerUp(event) {
    if (!active || event.pointerId !== active.pointerId) return;
    active.x = event.clientX; active.y = event.clientY;
    const dragging = active.mode === 'drag', menu = active.mode === 'pending' && active.held;
    const target = dragging ? targetAt(active.x, active.y) : null;
    const destination = target?.dataset?.dropZone || target?.getAttribute?.('data-drop-zone');
    if (active.mode !== 'pending' || menu) { suppressClick = true; event.preventDefault(); }
    finish();
    if (destination) onDrop(id, destination, { target, x: event.clientX, y: event.clientY });
    else if (menu) onMenu();
  }
  function pointerCancel(event) { if (active && event.pointerId === active.pointerId) { suppressClick = true; finish(); } }
  function keyDown(event) { if (event.key === 'Escape' && active) { event.preventDefault(); suppressClick = true; finish(); } }
  function click(event) {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
  }
  function contextMenu(event) {
    event.preventDefault();
    if (ignored(event)) return;
    // A touch hold may still turn into a drag. Open its menu when released.
    if (active?.touch) { active.held = true; element.classList?.add('pt-card-held'); return; }
    suppressClick = true; finish(); onMenu();
  }
  const nativeDrag = event => event.preventDefault();
  element.addEventListener('pointerdown', pointerDown); element.addEventListener('click', click, true); element.addEventListener('contextmenu', contextMenu); element.addEventListener('dragstart', nativeDrag);
  return () => {
    destroyed = true; finish();
    element.removeEventListener?.('pointerdown', pointerDown); element.removeEventListener?.('click', click, true); element.removeEventListener?.('contextmenu', contextMenu); element.removeEventListener?.('dragstart', nativeDrag);
    if (element.style) { element.style.touchAction = previousTouchAction || ''; element.style.webkitTouchCallout = previousCallout || ''; }
  };
}
