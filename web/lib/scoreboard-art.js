let serial = 0;
const SVG = 'http://www.w3.org/2000/svg';

export function winnerAward() {
  const id = 'score-gold-' + ++serial;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  svg.innerHTML = `<defs>
    <linearGradient id="${id}" x1="0" y1="0" x2=".8" y2="1"><stop stop-color="#fff3bc"/><stop offset=".36" stop-color="#eac16a"/><stop offset=".55" stop-color="#c18b32"/><stop offset=".72" stop-color="#f8db8a"/><stop offset="1" stop-color="#9f6727"/></linearGradient>
    <linearGradient id="${id}-face" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff3ba"/><stop offset="1" stop-color="#d8a548"/></linearGradient>
  </defs>
  <path d="M60 8 73 36 104 34 88 60 104 86 73 84 60 112 47 84 16 86 32 60 16 34 47 36Z" fill="url(#${id})" stroke="#835624" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M60 17 71 40 96 39 83 60 96 81 71 80 60 103 49 80 24 81 37 60 24 39 49 40Z" fill="none" stroke="#fff4bd" stroke-opacity=".65" stroke-width="1.5"/>
  <g fill="url(#${id}-face)" stroke="#98682d" stroke-width="1.6"><circle cx="60" cy="8" r="5"/><circle cx="104" cy="34" r="5"/><circle cx="104" cy="86" r="5"/><circle cx="60" cy="112" r="5"/><circle cx="16" cy="86" r="5"/><circle cx="16" cy="34" r="5"/></g>
  <circle cx="60" cy="60" r="25" fill="#9b6a29"/>
  <circle cx="60" cy="59" r="23" fill="url(#${id}-face)" stroke="#fff0ad" stroke-width="1.5"/>
  <circle cx="60" cy="59" r="19.5" fill="none" stroke="#ae792d" stroke-width="1"/>
  <path d="m60 44 4.7 9.6 10.6 1.5-7.6 7.4 1.8 10.5L60 68l-9.5 5 1.8-10.5-7.6-7.4 10.6-1.5Z" fill="#916025" stroke="#fff1b5" stroke-width="1.3" stroke-linejoin="round"/>
  <path d="M44 48a21 21 0 0 1 26-7" fill="none" stroke="#fff9dc" stroke-width="2" stroke-linecap="round" opacity=".8"/>`;
  return svg;
}

export function lifeSymbol(positive) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M5 12h14' + (positive ? 'M12 5v14' : ''));
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2'); path.setAttribute('stroke-linecap', 'round');
  svg.append(path); return svg;
}
