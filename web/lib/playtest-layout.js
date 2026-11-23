export function battlefieldPoint(position, width, height, cardWidth, cardHeight) {
  const travelX = Math.max(0, width - cardWidth - 40), travelY = Math.max(0, height - cardHeight - 16);
  if (position.x !== undefined) return { x: 20 + travelX * position.x / 1000, y: 8 + travelY * position.y / 1000 };
  const columns = Math.max(1, Math.floor((width - 40 + 6) / (cardWidth + 6)));
  const wrap = Math.floor(position.slot / columns), x = 20 + position.slot % columns * (cardWidth + 6);
  return { x, y: 8 + (position.row === 'lower' ? Math.max(0, travelY - wrap * 18) : Math.min(travelY, wrap * 18)) };
}

export function snappedBattlefieldPoint(x, y, width, height, cardWidth, cardHeight) {
  const travelX = Math.max(0, width - cardWidth - 40), travelY = Math.max(0, height - cardHeight - 16);
  const coordinate = (value, travel, inset) => travel ? Math.round(Math.min(travel, Math.max(0, Math.round((value - inset) / 6) * 6)) / travel * 1000) : 0;
  return { x: coordinate(x, travelX, 20), y: coordinate(y, travelY, 8) };
}

export function handCardGap(width, cardWidth, count) {
  return count <= 1 ? 6 : Math.max(26 - cardWidth, Math.min(6, (width - count * cardWidth) / (count - 1)));
}
