export function battlefieldPoint(position, width, height, cardWidth, cardHeight) {
  if (position.pixelX !== undefined) return { x: position.pixelX, y: position.pixelY };
  const travelX = Math.max(0, width - cardWidth - 40), travelY = Math.max(0, height - cardHeight - 16);
  if (position.x !== undefined) return { x: 20 + travelX * position.x / 1000, y: 8 + travelY * position.y / 1000 };
  return { x: 32 + position.slot * (cardWidth + 6), y: 8 + (position.row === 'lower' ? travelY : 0) };
}

export function battlefieldExtent(width, height, cardWidth, cardHeight, positions) {
  const bankHeight = Math.max(height, cardHeight * 2 + 32);
  const points = positions.map(position => battlefieldPoint(position, width, bankHeight, cardWidth, cardHeight));
  return { bankHeight, width: Math.max(width, ...points.map(point => point.x + cardWidth + 32)), height: Math.max(bankHeight, ...points.map(point => point.y + cardHeight + 8)) };
}

export function snappedBattlefieldPixels(x, y) {
  const snap = (value, inset) => Math.min(200000, inset + Math.max(0, Math.round((value - inset) / 6) * 6));
  return { pixelX: snap(x, 32), pixelY: snap(y, 8) };
}

export function snappedBattlefieldPoint(x, y, width, height, cardWidth, cardHeight) {
  const travelX = Math.max(0, width - cardWidth - 40), travelY = Math.max(0, height - cardHeight - 16);
  const coordinate = (value, travel, inset) => travel ? Math.round(Math.min(travel, Math.max(0, Math.round((value - inset) / 6) * 6)) / travel * 1000) : 0;
  return { x: coordinate(x, travelX, 20), y: coordinate(y, travelY, 8) };
}

export function handCardGap(width, cardWidth, count) {
  return count <= 1 ? 6 : Math.max(-cardWidth * .25, Math.min(6, (width - count * cardWidth) / (count - 1)));
}
