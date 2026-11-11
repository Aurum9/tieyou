const DRAG_THRESHOLD = 8;
const SCROLL_MARGIN = 48;
const SCROLL_STEP = 16;

export function createDeckEditorDrag(root, { onMove }) {
  const doc = root.ownerDocument || globalThis.document;
  const view = doc.defaultView || globalThis.window;
  const handles = new Map();
  const targets = new Map();
  let drag = null;
  let hovered = null;
  let scrollFrame = null;
  let suppressClick = false;
  let disposed = false;

  function registeredAncestor(node, registered) {
    for (let current = node; current && current !== root; current = current.parentNode) {
      if (registered.has(current)) return current;
    }
    return null;
  }

  function targetAt(x, y) {
    return registeredAncestor(doc.elementFromPoint(x, y), targets);
  }

  function hover(target) {
    if (hovered === target) return;
    hovered?.classList.remove('is-drag-over');
    hovered = target;
    hovered?.classList.add('is-drag-over');
  }

  function revealTargets() {
    const headers = [...targets.keys()].filter(target => target.getBoundingClientRect().height > 0);
    const visible = headers.some(target => {
      const { top, bottom } = target.getBoundingClientRect();
      return top < view.innerHeight - SCROLL_MARGIN && bottom > SCROLL_MARGIN;
    });
    if (!visible) headers[0]?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }

  function requestScroll() {
    if (!drag?.started || scrollFrame !== null) return;
    const { x, y } = drag;
    if (x < 0 || x >= view.innerWidth || y < 0 || y >= view.innerHeight) return;
    const distance = y < SCROLL_MARGIN ? y - SCROLL_MARGIN : Math.max(0, y - (view.innerHeight - SCROLL_MARGIN));
    if (!distance) return;
    const delta = Math.sign(distance) * Math.ceil(SCROLL_STEP * Math.abs(distance) / SCROLL_MARGIN);
    scrollFrame = view.requestAnimationFrame(() => {
      scrollFrame = null;
      if (!drag?.started) return;
      const previousY = view.scrollY;
      view.scrollBy({ top: delta, behavior: 'instant' });
      hover(targetAt(drag.x, drag.y));
      if (view.scrollY !== previousY) requestScroll();
    });
  }

  function beginDrag() {
    drag.started = true;
    drag.scrollX = view.scrollX;
    drag.scrollY = view.scrollY;
    suppressClick = true;
    // The handle can disappear when the card rows collapse.
    try { root.setPointerCapture?.(drag.pointerId); } catch { /* The pointer may have ended. */ }
    root.classList.add('is-dragging');
    drag.handle.classList.add('is-drag-source');
    for (const target of targets.keys()) target.classList.add('is-drop-target');
    revealTargets();
  }

  function cancel() {
    if (!drag) return;
    const finished = drag;
    drag = null;
    doc.removeEventListener('pointermove', pointerMove, true);
    doc.removeEventListener('pointerup', pointerUp, true);
    doc.removeEventListener('pointercancel', pointerCancel, true);
    doc.removeEventListener('keydown', keyDown, true);
    view.removeEventListener('blur', cancel);
    if (!finished.started) return;
    if (scrollFrame !== null) {
      view.cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    if (root.hasPointerCapture?.(finished.pointerId)) root.releasePointerCapture(finished.pointerId);
    root.classList.remove('is-dragging');
    finished.handle.classList.remove('is-drag-source');
    hover(null);
    for (const target of targets.keys()) target.classList.remove('is-drop-target');
    if (view.scrollX !== finished.scrollX || view.scrollY !== finished.scrollY) {
      view.scrollTo({ left: finished.scrollX, top: finished.scrollY, behavior: 'instant' });
    }
  }

  function pointerDown(event) {
    if (disposed || drag || event.isPrimary === false || event.button !== 0) return;
    suppressClick = false;
    const handle = registeredAncestor(event.target, handles);
    if (!handle || handle.disabled || !targets.size) return;
    drag = { handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, started: false };
    doc.addEventListener('pointermove', pointerMove, { capture: true, passive: false });
    doc.addEventListener('pointerup', pointerUp, true);
    doc.addEventListener('pointercancel', pointerCancel, true);
    doc.addEventListener('keydown', keyDown, true);
    view.addEventListener('blur', cancel);
  }

  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.started) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < DRAG_THRESHOLD) return;
      beginDrag();
    }
    event.preventDefault();
    hover(targetAt(drag.x, drag.y));
    requestScroll();
  }

  function pointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const target = drag.started ? targetAt(event.clientX, event.clientY) : null;
    const entryId = handles.get(drag.handle).entryId;
    if (drag.started) event.preventDefault();
    cancel();
    if (target) onMove(entryId, targets.get(target));
  }

  function pointerCancel(event) {
    if (event.pointerId === drag?.pointerId) cancel();
  }

  function keyDown(event) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function click(event) {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function nativeDrag(event) {
    if (registeredAncestor(event.target, handles)) event.preventDefault();
  }

  root.addEventListener('pointerdown', pointerDown);
  root.addEventListener('click', click, true);
  root.addEventListener('dragstart', nativeDrag);

  return {
    registerHandle(handle, entryId) {
      handles.set(handle, { entryId, touchAction: handle.style?.touchAction });
      if (handle.style) handle.style.touchAction = 'none';
    },
    registerTarget(target, payload) { targets.set(target, payload); },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      root.removeEventListener?.('pointerdown', pointerDown);
      root.removeEventListener?.('click', click, true);
      root.removeEventListener?.('dragstart', nativeDrag);
      for (const [handle, { touchAction }] of handles) {
        if (handle.style) handle.style.touchAction = touchAction;
      }
      handles.clear();
      targets.clear();
    },
  };
}
