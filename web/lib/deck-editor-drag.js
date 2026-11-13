const DRAG_THRESHOLD = 8;
const TOUCH_HOLD_MS = 350;
const SCROLL_MARGIN = 48;
const SCROLL_STEP = 16;
const PREVIEW_OFFSET = 12;
const NONPASSIVE_CAPTURE = { capture: true, passive: false };

export function createDeckEditorDrag(root, { inputRoot = root, onMove, onAdd, onDragChange }) {
  const doc = root.ownerDocument || globalThis.document;
  const view = doc.defaultView || globalThis.window;
  const handles = new Map();
  const targets = new Map();
  let drag = null;
  let ghost = null;
  let hovered = null;
  let frame = null;
  let suppressClick = false;
  let disposed = false;

  function registeredAncestor(node, registered, boundary) {
    for (let current = node; current && current !== boundary; current = current.parentNode) {
      if (registered.has(current)) return current;
    }
    return null;
  }

  function targetAt(x, y) {
    return registeredAncestor(doc.elementFromPoint(x, y), targets, root);
  }

  function hover(target) {
    if (hovered === target) return;
    hovered?.classList.remove('is-drag-over');
    hovered = target;
    hovered?.classList.add('is-drag-over');
  }

  function scrollNearEdge() {
    const { x, y } = drag;
    if (x < 0 || x >= view.innerWidth || y < 0 || y >= view.innerHeight) return;
    const distance = y < SCROLL_MARGIN ? y - SCROLL_MARGIN : Math.max(0, y - (view.innerHeight - SCROLL_MARGIN));
    if (!distance) return;
    const delta = Math.sign(distance) * Math.ceil(SCROLL_STEP * Math.abs(distance) / SCROLL_MARGIN);
    view.scrollBy({ top: delta, behavior: 'instant' });
  }

  function showGhost() {
    const { preview } = handles.get(drag.handle);
    const name = preview?.name || drag.handle.getAttribute?.('aria-label');
    if (!name) return;
    ghost = doc.createElement('div');
    ghost.className = 'deck-editor-drag-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    const label = doc.createElement('span');
    label.textContent = name;
    ghost.append(label);
    if (/^https?:\/\//i.test(preview?.image || '')) {
      const art = doc.createElement('img');
      art.alt = '';
      art.decoding = 'async';
      art.draggable = false;
      art.referrerPolicy = 'no-referrer';
      const previewElement = ghost;
      art.addEventListener('load', () => previewElement.classList.add('has-image'), { once: true });
      art.src = preview.image;
      ghost.append(art);
    }
    doc.body.append(ghost);
    positionGhost();
  }

  function positionGhost() {
    if (!ghost) return;
    const { x, y, touch } = drag;
    const { offsetWidth: width, offsetHeight: height } = ghost;
    const afterX = x + PREVIEW_OFFSET + width <= view.innerWidth;
    const aboveY = touch || y + PREVIEW_OFFSET + height > view.innerHeight;
    const left = afterX ? x + PREVIEW_OFFSET : x - width - PREVIEW_OFFSET;
    const top = aboveY ? y - height - PREVIEW_OFFSET : y + PREVIEW_OFFSET;
    const boundedLeft = Math.max(0, Math.min(left, view.innerWidth - width));
    const boundedTop = Math.max(0, Math.min(top, view.innerHeight - height));
    ghost.style.transform = `translate3d(${boundedLeft}px, ${boundedTop}px, 0)`;
  }

  function animateDrag() {
    if (!drag?.started) return;
    if (drag.moved) {
      scrollNearEdge();
      // A collapsing lane can move a header under a stationary pointer.
      hover(targetAt(drag.x, drag.y));
    }
    positionGhost();
    frame = view.requestAnimationFrame(animateDrag);
  }

  function beginDrag() {
    drag.started = true;
    suppressClick = true;
    if (!drag.touch) {
      // The handle can disappear when the card rows collapse.
      try { root.setPointerCapture?.(drag.id); } catch { /* The pointer may have ended. */ }
    }
    root.classList.add('is-dragging');
    drag.handle.classList.add('is-drag-source');
    for (const target of targets.keys()) target.classList.add('is-drop-target');
    showGhost();
    frame = view.requestAnimationFrame(animateDrag);
    onDragChange?.(true);
  }

  function cancel() {
    if (!drag) return;
    const finished = drag;
    drag = null;
    if (finished.touch) {
      clearTimeout(finished.holdTimer);
      doc.removeEventListener('touchstart', additionalTouch, true);
      doc.removeEventListener('touchmove', touchMove, true);
      doc.removeEventListener('touchend', touchEnd, true);
      doc.removeEventListener('touchcancel', touchCancel, true);
    } else {
      doc.removeEventListener('pointermove', pointerMove, true);
      doc.removeEventListener('pointerup', pointerUp, true);
      doc.removeEventListener('pointercancel', pointerCancel, true);
    }
    doc.removeEventListener('keydown', keyDown, true);
    view.removeEventListener('blur', cancel);
    if (!finished.started) return;
    if (frame !== null) {
      view.cancelAnimationFrame(frame);
      frame = null;
    }
    ghost?.remove();
    ghost = null;
    if (!finished.touch && root.hasPointerCapture?.(finished.id)) root.releasePointerCapture(finished.id);
    root.classList.remove('is-dragging');
    finished.handle.classList.remove('is-drag-source');
    hover(null);
    for (const target of targets.keys()) target.classList.remove('is-drop-target');
    onDragChange?.(false);
  }

  function track(handle, id, { clientX, clientY }, touch = false) {
    suppressClick = false;
    drag = { handle, id, touch, startX: clientX, startY: clientY, x: clientX, y: clientY, started: false, moved: false };
    doc.addEventListener('keydown', keyDown, true);
    view.addEventListener('blur', cancel);
  }

  function pointerDown(event) {
    if (disposed || drag || event.isPrimary === false || event.button !== 0) return;
    suppressClick = false;
    const handle = registeredAncestor(event.target, handles, inputRoot);
    if (!handle || handle.disabled || !targets.size) return;
    if (event.pointerType === 'touch' && handles.get(handle).touchHold) return;
    track(handle, event.pointerId, event);
    doc.addEventListener('pointermove', pointerMove, NONPASSIVE_CAPTURE);
    doc.addEventListener('pointerup', pointerUp, true);
    doc.addEventListener('pointercancel', pointerCancel, true);
  }

  function updatePosition({ clientX, clientY }) {
    drag.x = clientX;
    drag.y = clientY;
    drag.moved ||= Math.hypot(clientX - drag.startX, clientY - drag.startY) >= DRAG_THRESHOLD;
  }

  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    updatePosition(event);
    if (!drag.started) {
      if (!drag.moved) return;
      beginDrag();
    }
    event.preventDefault();
    hover(targetAt(drag.x, drag.y));
  }

  function pointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    finishDrop(event, event);
  }

  function finishDrop(event, { clientX, clientY }) {
    const target = drag.started && drag.moved ? targetAt(clientX, clientY) : null;
    const { source, onDrop } = handles.get(drag.handle);
    const destination = targets.get(target);
    if (drag.started) event.preventDefault();
    cancel();
    if (target) onDrop?.(source, destination);
  }

  function pointerCancel(event) {
    if (event.pointerId === drag?.id) cancel();
  }

  function touchStart(event) {
    if (disposed || drag || event.touches.length !== 1 || !targets.size) return;
    const handle = registeredAncestor(event.target, handles, inputRoot);
    if (!handle || handle.disabled || !handles.get(handle).touchHold) return;
    const touch = event.changedTouches[0];
    track(handle, touch.identifier, touch, true);
    drag.holdTimer = setTimeout(beginDrag, TOUCH_HOLD_MS);
    doc.addEventListener('touchstart', additionalTouch, true);
    // Prevent scrolling only after the hold. A swipe before then can scroll the page normally.
    doc.addEventListener('touchmove', touchMove, NONPASSIVE_CAPTURE);
    doc.addEventListener('touchend', touchEnd, NONPASSIVE_CAPTURE);
    doc.addEventListener('touchcancel', touchCancel, true);
  }

  function changedTouch(event) {
    return Array.from(event.changedTouches).find(touch => touch.identifier === drag?.id);
  }

  function additionalTouch(event) {
    if (event.touches.length > 1) cancel();
  }

  function touchMove(event) {
    const touch = changedTouch(event);
    if (!touch) return;
    if (event.cancelable === false) { cancel(); return; }
    updatePosition(touch);
    if (drag.started) {
      event.preventDefault();
      if (drag.moved) hover(targetAt(drag.x, drag.y));
    } else if (drag.moved) cancel();
  }

  function touchEnd(event) {
    const touch = changedTouch(event);
    if (touch) finishDrop(event, touch);
  }

  function touchCancel(event) {
    if (changedTouch(event)) cancel();
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
    if (registeredAncestor(event.target, handles, inputRoot)) event.preventDefault();
  }

  function contextMenu(event) {
    if (drag?.touch) event.preventDefault();
  }

  inputRoot.addEventListener('pointerdown', pointerDown);
  inputRoot.addEventListener('touchstart', touchStart, { passive: true });
  inputRoot.addEventListener('contextmenu', contextMenu);
  inputRoot.addEventListener('click', click, true);
  inputRoot.addEventListener('dragstart', nativeDrag);

  function registerSource(handle, source, onDrop, { touchHold = false, preview } = {}) {
    handles.get(handle)?.unregister();
    const { style } = handle;
    const touchProperty = touchHold ? 'webkitTouchCallout' : 'touchAction';
    const previousStyle = style?.[touchProperty] || '';
    if (style) style[touchProperty] = 'none';
    function unregister() {
      if (handles.get(handle)?.unregister !== unregister) return;
      handles.delete(handle);
      if (style) style[touchProperty] = previousStyle;
      if (drag?.handle === handle) cancel();
    }
    handles.set(handle, { source, onDrop, touchHold, preview, unregister });
    return unregister;
  }

  return {
    registerHandle(handle, entryId, options) { return registerSource(handle, entryId, onMove, options); },
    registerExternalHandle(handle, source, options) { return registerSource(handle, source, onAdd, options); },
    registerTarget(target, payload) { targets.set(target, payload); },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      inputRoot.removeEventListener?.('pointerdown', pointerDown);
      inputRoot.removeEventListener?.('touchstart', touchStart);
      inputRoot.removeEventListener?.('contextmenu', contextMenu);
      inputRoot.removeEventListener?.('click', click, true);
      inputRoot.removeEventListener?.('dragstart', nativeDrag);
      for (const registration of handles.values()) registration.unregister();
      targets.clear();
    },
  };
}
