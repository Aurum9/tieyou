// Older in-app browsers can load modules while missing these built-ins.
function defineFallback(target, name, fallback) {
  if (typeof target[name] !== 'function') {
    Object.defineProperty(target, name, { value: fallback, configurable: true, writable: true });
  }
}

defineFallback(Object, 'hasOwn', function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key);
});

defineFallback(Array.prototype, 'at', function at(index) {
  const offset = Math.trunc(index) || 0;
  const position = offset < 0 ? this.length + offset : offset;
  return position >= 0 && position < this.length ? this[position] : undefined;
});

defineFallback(Array.prototype, 'findLast', function findLast(predicate, receiver) {
  for (let index = this.length - 1; index >= 0; index--) {
    const value = this[index];
    if (predicate.call(receiver, value, index, this)) return value;
  }
  return undefined;
});

defineFallback(Element.prototype, 'replaceChildren', function replaceChildren(...children) {
  const fragment = this.ownerDocument.createDocumentFragment();
  fragment.append(...children);
  this.textContent = '';
  this.appendChild(fragment);
});

defineFallback(AbortSignal, 'timeout', function timeout(milliseconds) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), milliseconds);
  return controller.signal;
});
