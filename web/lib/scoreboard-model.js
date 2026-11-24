export const SEATS = ['红方', '蓝方', '黄方', '绿方'];
export const COMMANDER_QUERY = '((t:legendary t:creature) OR o:"can be your commander" OR (t:legendary t:background) OR name="Grist, the Hunger Tide")';
const ruleText = card => card?.faces?.[0]?.oracleText || card?.oracleText || '';
const typeText = card => card?.faces?.[0]?.typeLine || card?.typeLine || '';
const normalized = value => String(value).normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase().trim();

export function commanderRule(card) {
  if (card?.pair) return card.pair;
  const text = ruleText(card), type = typeText(card);
  const named = text.match(/^Partner with ([^\n(]+)/im);
  if (named) return { kind: 'named', target: named[1].trim() };
  if (/^Choose a Background\b/im.test(text)) return { kind: 'choose-background' };
  if (/\bBackground\b/i.test(type)) return { kind: 'background' };
  if (/^Doctor['’]s companion\b/im.test(text)) return { kind: 'companion' };
  if (/\bTime Lord Doctor\b/i.test(type)) return { kind: 'doctor' };
  const group = text.match(/^Partner\s*[—–-]\s*([^\n(]+)/im);
  if (group) return { kind: 'group', target: group[1].trim() };
  if (/^Friends forever\b/im.test(text)) return { kind: 'group', target: 'Friends forever' };
  if (/^Partner(?:\s*\(|\s*$)/im.test(text)) return { kind: 'partner' };
  return null;
}
export function commanderEligible(card) {
  const text = ruleText(card), type = typeText(card);
  if (/can't be your commander/i.test(text)) return false;
  // Characteristic-defining ability outside the battlefield: MH2 release notes.
  // https://magic.wizards.com/en/news/feature/modern-horizons-2-release-notes-2021-06-04
  if (card.name === 'Grist, the Hunger Tide') return true;
  return (/\bLegendary\b/i.test(type) && /\b(?:Creature|Background)\b/i.test(type)) || /can be your commander\./i.test(text);
}
export function commanderPairFits(first, second) {
  if (!first || !second || first.id === second.id) return false;
  const a = commanderRule(first), b = commanderRule(second);
  if (!a || !b) return false;
  if (a.kind === 'named') return normalized(a.target) === normalized(second.name) && b.kind === 'named' && normalized(b.target) === normalized(first.name);
  return a.kind === 'partner' && b.kind === 'partner' || a.kind === 'group' && b.kind === 'group' && normalized(a.target) === normalized(b.target) ||
    a.kind === 'choose-background' && b.kind === 'background' || a.kind === 'background' && b.kind === 'choose-background' ||
    a.kind === 'doctor' && b.kind === 'companion' || a.kind === 'companion' && b.kind === 'doctor';
}
export function commanderSnapshot(card) {
  const version = card.versions?.find(v => v.id === card.defaultVersionId) || card.versions?.[0];
  const image = version?.faceImages?.[0] || version?.image || card.image || card.faces?.[0]?.image || '';
  return { id: card.id, name: card.name, zhName: card.zhName || '', image: /^https?:\/\//i.test(image) ? image : '', pair: commanderRule(card) };
}
export function freshTable() {
  return { version: 1, phase: 'setup', players: SEATS.map((name, seat) => ({ seat, name, life: 40, commanders: [] })), game: null };
}
export function startTable(table, { first = Math.floor(Math.random() * 4), now = new Date().toISOString(), id = globalThis.crypto.randomUUID() } = {}) {
  if (table.phase === 'playing') throw new Error('当前对局尚未结束');
  if (!Number.isInteger(first) || first < 0 || first > 3) throw new Error('先手位置无效');
  return { ...table, phase: 'playing', players: table.players.map(p => ({ ...p, life: 40 })), game: { id, startedAt: now, first } };
}
export function finishTable(table, winner, now = new Date().toISOString()) {
  if (table.phase !== 'playing' || !Number.isInteger(winner) || winner < 0 || winner > 3) throw new Error('请拖到赢家面板');
  return validateGameRecord({ ...table.game, endedAt: now, winner, players: table.players });
}
export function validateGameRecord(value) {
  if (!value || !/^[a-zA-Z0-9-]{16,64}$/.test(value.id || '') || !Array.isArray(value.players) || value.players.length !== 4 ||
    !Number.isInteger(value.first) || value.first < 0 || value.first > 3 || !Number.isInteger(value.winner) || value.winner < 0 || value.winner > 3) throw new Error('对局记录无效');
  const start = Date.parse(value.startedAt), end = Date.parse(value.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 300000) throw new Error('对局时间无效');
  const note = value.note ?? '';
  if (typeof note !== 'string' || note.length > 2000) throw new Error('备注最多 2000 个字符');
  const noteUpdatedAt = value.noteUpdatedAt || value.endedAt;
  if (!Number.isFinite(Date.parse(noteUpdatedAt))) throw new Error('备注时间无效');
  const players = value.players.map((p, seat) => {
    if (!p || !Number.isInteger(p.life) || Math.abs(p.life) > 9999 || !Array.isArray(p.commanders) || p.commanders.length > 2) throw new Error('玩家信息无效');
    const commanders = p.commanders.map(c => {
      if (!c || typeof c.id !== 'string' || c.id.length > 100 || !c.id || typeof c.name !== 'string' || c.name.length > 200 || !c.name) throw new Error('统帅信息无效');
      if (c.image && (typeof c.image !== 'string' || c.image.length > 1500 || !/^https?:\/\//i.test(c.image))) throw new Error('统帅图片无效');
      return { id: c.id, name: c.name, zhName: String(c.zhName || '').slice(0, 200), image: c.image || '' };
    });
    return { seat, name: SEATS[seat], life: p.life, commanders };
  });
  return { id: value.id, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), first: value.first, winner: value.winner, players, note, noteUpdatedAt: new Date(noteUpdatedAt).toISOString() };
}
