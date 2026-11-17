export const TYPE_NAMES = {
  Artifact: '神器', Battle: '战役', Creature: '生物', Enchantment: '结界',
  Instant: '瞬间', Kindred: '亲缘', Land: '地', Planeswalker: '鹏洛客', Sorcery: '法术',
  Tribal: '部族', Conspiracy: '诡局', Dungeon: '地城', Plane: '时空',
  Phenomenon: '异象', Scheme: '阴谋', Vanguard: '先锋',
};
export const SUPERTYPE_NAMES = {
  Basic: '基本', Legendary: '传奇', Snow: '雪境', World: '世界', Ongoing: '持续', Elite: '精英',
};

const prefixes = Object.keys(TYPE_NAMES);
const subtypesOf = line => line.match(/Time Lord|[^\s／/]+/g) || [];

export function collectSubtypes(vocabulary, face) {
  const [prefix, suffix] = String(face.typeLine || '').split(/\s*[—–]\s*/);
  if (!suffix) return;
  const parentTypes = prefix.split(/\s+/).filter(word => prefixes.includes(word));
  const english = parentTypes.includes('Plane') ? [suffix.trim()] : subtypesOf(suffix);
  const chinese = subtypesOf(String(face.zhTypeLine || '').split(/[—–～~]/)[1] || '');
  for (const [i, value] of english.entries()) {
    if (!vocabulary.has(value)) vocabulary.set(value, { direct: new Set(), observed: new Set(), translations: new Map() });
    const item = vocabulary.get(value);
    for (const type of parentTypes) item.observed.add(type);
    if (parentTypes.length === 1) item.direct.add(parentTypes[0]);
    if (chinese.length === english.length && /\p{Script=Han}/u.test(chinese[i])) {
      item.translations.set(chinese[i], (item.translations.get(chinese[i]) || 0) + 1);
    }
  }
}

export function describeSubtypes(vocabulary) {
  return Array.from(vocabulary, ([value, item]) => {
    const aliases = [...item.translations].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const parents = [...(item.direct.size ? item.direct : item.observed)]
      .map(type => TYPE_NAMES[type]).join('、');
    return { value, label: aliases[0] || value, aliases, detail: parents ? parents + '副类别' : '副类别' };
  }).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}
