const otherTagNames = { draw: '抓牌', 'draw-engine': '抓牌引擎', loot: '抓后弃', rummage: '弃后抓', wheel: '转轮', 'impulsive-draw': '冲动抓牌', ramp: '加速', 'mana-rock': '法术力石', 'mana-dork': '产费生物', ritual: '一次性产费', 'cost-reducer': '减费', 'land-ramp': '地加速', 'extra-land': '额外下地', tutor: '检索', 'tutor-land': '找地', 'tutor-creature': '找生物', 'tutor-artifact': '找神器', 'spot-removal': '单体去除', sweeper: '清场', counterspell: '反击', bounce: '回手', discard: '弃牌干扰', burn: '烧伤', theft: '偷取', flicker: '闪烁', recursion: '坟场回收', regrowth: '坟场回手', reanimate: '复活', 'hate-graveyard': '坟场针对', 'sacrifice-outlet': '牺牲源', protection: '保护', 'gives-hexproof': '赋予辟邪', 'gives-indestructible': '赋予不灭', fog: '防止战斗伤害', pillowfort: '枕头堡', anthem: '全队强化', overrun: '践踏爆发', 'extra-turn': '额外回合', 'extra-combat-phase': '额外战斗', 'drain-life': '吸血', lifegain: '获得生命', 'copy-spell': '复制咒语', 'copy-creature': '复制生物', landfall: '地落', 'sacrifice-matters': '牺牲协同', 'lifegain-matters': '加血协同', 'pp-counters-matter': '+1/+1 指示物协同', 'synergy-equipment': '武具协同', 'synergy-aura': '灵气协同', tax: '征税', hatebear: '干扰小生物', 'typal-elf': '妖精部族协同', 'typal-dragon': '龙部族协同', 'alternate-win-condition': '特殊胜利条件' };

export const LAND_TAG_NAMES = {
  'cycle-land': '地牌循环',
  'cycle-mono-land': '单色地组',
  'cycle-dual-land': '双色地组',
  'cycle-triland': '三色地组',
  'cycle-colorless-land': '无色地组',
  'cycle-nonmana-land': '不产费地组',
  'cycle-cycling-land': '循环异能地组',
  'supercycle-legendary-land': '跨系列传奇地组',
  'cycle-lea-basic-land': '基本地组',
  'cycle-basic-snow-land': '雪境基本地组',
  'cycle-khm-realm': '凯德海姆境域地组',
  'cycle-lrw-typal-land': '洛温部族地组',
  'cycle-lrw-typal-dual-land': '洛温部族双色地组',
  'cycle-lrw-vivid-land': '洛温鲜烈地组',
  'cycle-rav-guildhall': '拉尼卡公会会堂地组',

  'cycle-abu-dual-land': '老圈',
  'cycle-rav-shockland': '电震圈',
  'tricycle-land': '三色圈',
  'cycle-iko-triome': '依克黎三色圈',
  'cycle-snc-triland': '新卡佩纳三色圈',
  'cycle-dual-surveil-land': '刺探圈',
  'cycle-sos-surveil-dual': 'SOS 刺探地',
  'cycle-spm-surveil-dual': 'SPM 刺探地',
  'cycle-khm-snow-tapland': '雪境圈',
  'cycle-csp-snow-tapland': 'CSP 雪境双色地',
  'cycle-tangoland': '战斗圈',
  'cycle-bfz-tangoland': '再战赞迪卡战斗圈',
  'cycle-dmu-dual-land': '多明纳里亚横进圈',
  'cycle-turbulent-land': '湍漩圈',
  'cycle-soc-octoland': 'SOC 湍漩圈',
  'cycle-dual-cycling-land': '双色循环圈',
  'cycle-akh-dual-cycling-land': '阿芒凯双色循环圈',

  'cycle-fetchland': '经典找地地组',
  'cycle-ons-fetchland': '石破天惊找地地',
  'cycle-zen-fetchland': '赞迪卡找地地',
  'cycle-mir-fetchland': '海市蜃楼找地地',
  'cycle-ala-panorama': '阿拉若全景地',
  'cycle-mh3-landscape': 'MH3 地境地',
  'cycle-snc-fetchland': '新卡佩纳找地地',
  'cycle-painland': '经典痛地',
  'cycle-ice-painland': '冰雪时代痛地',
  'cycle-apc-painland': '启示录痛地',
  'cycle-checkland': '检查地',
  'cycle-m10-checkland': 'M10 检查地',
  'cycle-isd-checkland': '依尼翠检查地',
  'cycle-fastland': '快地',
  'cycle-som-fastland': '秘罗地创痕快地',
  'cycle-kld-fastland': '卡拉德许快地',
  'cycle-slowland': '慢地',
  'cycle-mid-slowland': '黯夜猎踪慢地',
  'cycle-vow-slowland': '腥红婚誓慢地',
  'cycle-bondland': '多人地',
  'cycle-bbd-bond-land': 'BBD 多人地',
  'cycle-cmr-bond-land': 'CMR 多人地',
  'cycle-reveal-land': '展示地',
  'cycle-soi-reveal-land': 'SOI 展示地',
  'cycle-stx-reveal-land': 'STX 展示地',
  'cycle-horizon-land': '地平线地',
  'cycle-rav-bounceland': '拉尼卡回手地',
  'cycle-guildgate': '公会门组',
  'cycle-pathway': '双面通路地',
  'cycle-znr-pathway': '赞迪卡通路地',
  'cycle-khm-pathway': '凯德海姆通路地',
  'cycle-hybrid-filterland': '混血串地',
  'cycle-shm-filterland': '暗影荒原串地',
  'cycle-eve-filterland': 'EVE 混血串地',
  'cycle-ody-filterland': '单费串地',
  'cycle-ody-ally-filterland': '奥德赛串地',
  'cycle-pip-enemy-filterland': 'PIP 串地',
  'cycle-dual-tapland': '双色横进地组',
  'cycle-triple-tapland': '三色横进地组',
  'cycle-dual-creatureland': '双色变人地',
  'cycle-restless-land': '不息变人地',
  'cycle-block-ths-scry-land': '占卜殿堂地',
  'cycle-ktk-gainland': '鞑契回血地',
  'cycle-mh2-bridge': '神器桥地',
  'cycle-mrd-artifact-land': '秘罗地神器地',
  'cycle-neo-legendary-land': '神河霓朝传奇地组',
  'cycle-eld-castle': '艾卓城堡地组',
  'cycle-verge': '边陲地',
  'cycle-dsk-verge': 'DSK 边陲地',
  'cycle-dft-verge': 'DFT 边陲地',
  'cycle-ala-shardland': '阿拉若三色横进地',
  'cycle-ktk-wedgeland': '鞑契三色横进地',

  'dual-land': '双色地',
  triland: '三色地',
  shardland: '弧三色地',
  wedgeland: '楔三色地',
  'rainbow-land': '五色地',
  'utility-land': '功能地',
  tapland: '横进地',
  'conditional-tapland': '条件横进地',
  fetchland: '找地地',
  shockland: '电震地',
  painland: '痛地',
  filterland: '串地',
  creatureland: '变人地',
  bounceland: '回手地',
  gainland: '回血地',
  'storage-land': '蓄费地',
  'depletion-land': '消耗式产费地',
};

export const TAG_NAMES = {
  ...otherTagNames,
  ...LAND_TAG_NAMES,
  'castable-from-graveyard': '可从坟场施放',
};
export const DEFAULT_TAG_NAMES = Object.freeze({ ...TAG_NAMES });

export function visibleTagLabel(slug) {
  slug = canonicalTagSlug(slug);
  return Object.hasOwn(TAG_NAMES, slug) ? TAG_NAMES[slug] : '';
}

const normalizeLabel = label => String(label ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
const localizedTags = new Map(Object.entries(TAG_NAMES).map(([slug, label]) => [normalizeLabel(label), [slug]]));
const localizedAliases = {
  地循环: ['cycle-land'],
  老双地: ['cycle-abu-dual-land'],
  原版双地: ['cycle-abu-dual-land'],
  经典找地地: ['cycle-fetchland'],
  找地地组: ['cycle-fetchland'],
  抓地地: ['fetchland'],
  三色循环地: ['tricycle-land'],
  双色循环地: ['cycle-dual-cycling-land'],
  刺探地: ['cycle-dual-surveil-land', 'cycle-sos-surveil-dual', 'cycle-spm-surveil-dual'],
  斯翠海文刺探地: ['cycle-sos-surveil-dual'],
  蜘蛛侠刺探地: ['cycle-spm-surveil-dual'],
  雪境双色地: ['cycle-khm-snow-tapland', 'cycle-csp-snow-tapland'],
  探戈地: ['cycle-tangoland'],
  战斗地: ['cycle-tangoland'],
  滤费地: ['filterland'],
  混血滤费地: ['cycle-hybrid-filterland'],
  反弹地: ['bounceland'],
};
for (const [label, slugs] of Object.entries(localizedAliases)) localizedTags.set(label, slugs);

export function localizedTagSlugs(value) {
  return localizedTags.get(normalizeLabel(value));
}

const canonicalAliases = new Map(), searchAliases = new Map();
export function applyTagAliases(aliases = {}) {
  canonicalAliases.clear(); searchAliases.clear();
  for (const [slug, values] of Object.entries(aliases)) {
    if (!Array.isArray(values)) continue;
    searchAliases.set(slug, [...new Set([slug, ...values.filter(value => typeof value === 'string')].map(normalizeLabel))]);
    canonicalAliases.set(normalizeLabel(slug), slug);
  }
  for (const [slug, values] of searchAliases) for (const value of values) if (!canonicalAliases.has(value)) canonicalAliases.set(value, slug);
}
export function canonicalTagSlug(value) { return canonicalAliases.get(normalizeLabel(value)) || value; }
export function searchTagSlugs(value) {
  const translated = localizedTagSlugs(value) || [canonicalTagSlug(value)];
  return [...new Set(translated.flatMap(slug => searchAliases.get(slug) || [slug, String(slug).replace(/ /g, '-')]))];
}

/** UI visibility never removes the underlying tag or its explicit search syntax. */
export function applyTagOverrides(overrides = {}) {
  for (const slug of Object.keys(TAG_NAMES)) delete TAG_NAMES[slug];
  Object.assign(TAG_NAMES, DEFAULT_TAG_NAMES);
  localizedTags.clear();
  const addAlias = (label, slug) => {
    const key = normalizeLabel(label); if (!key) return;
    localizedTags.set(key, [...new Set([...(localizedTags.get(key) || []), slug])]);
  };
  for (const [slug, label] of Object.entries(DEFAULT_TAG_NAMES)) addAlias(label, slug);
  for (const [label, slugs] of Object.entries(localizedAliases)) for (const slug of slugs) addAlias(label, slug);
  for (const [slug, item] of Object.entries(overrides)) {
    if (!slug || slug.length > 200 || /[\u0000-\u001f\u007f]/u.test(slug) || ['__proto__', 'prototype', 'constructor'].includes(slug) || !item || typeof item.label !== 'string' || typeof item.visible !== 'boolean') continue;
    if (item.visible && item.label.trim()) TAG_NAMES[slug] = item.label.trim();
    else delete TAG_NAMES[slug];
    addAlias(item.label, slug);
  }
}

