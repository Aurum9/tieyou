export const TAG_NAMES = { draw: '抓牌', 'draw-engine': '抓牌引擎', loot: '抓后弃', rummage: '弃后抓', wheel: '转轮', 'impulsive-draw': '冲动抓牌', ramp: '加速', 'mana-rock': '法术力石', 'mana-dork': '产费生物', ritual: '一次性产费', 'cost-reducer': '减费', 'land-ramp': '地加速', 'extra-land': '额外下地', tutor: '检索', 'tutor-land': '找地', 'tutor-creature': '找生物', 'tutor-artifact': '找神器', 'spot-removal': '单体去除', sweeper: '清场', counterspell: '反击', bounce: '回手', discard: '弃牌干扰', burn: '烧伤', theft: '偷取', flicker: '闪烁', recursion: '坟场回收', regrowth: '坟场回手', reanimate: '复活', 'hate-graveyard': '坟场针对', 'sacrifice-outlet': '牺牲源', protection: '保护', 'gives-hexproof': '赋予辟邪', 'gives-indestructible': '赋予不灭', fog: '防止战斗伤害', pillowfort: '枕头堡', anthem: '全队强化', overrun: '践踏爆发', 'extra-turn': '额外回合', 'extra-combat-phase': '额外战斗', 'drain-life': '吸血', lifegain: '获得生命', 'copy-spell': '复制咒语', 'copy-creature': '复制生物', landfall: '地落', 'sacrifice-matters': '牺牲协同', 'lifegain-matters': '加血协同', 'pp-counters-matter': '+1/+1 指示物协同', 'synergy-equipment': '武具协同', 'synergy-aura': '灵气协同', tax: '征税', hatebear: '干扰小生物', 'typal-elf': '妖精部族协同', 'typal-dragon': '龙部族协同', 'alternate-win-condition': '特殊胜利条件' };
let request;

export function loadTagVocabulary() {
  request ??= fetch(new URL('../data/tag-vocabulary.json', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error('标签词表暂时无法载入');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('标签词表格式无效');
    return rows;
  }).catch(error => {
    request = undefined;
    throw error;
  });
  return request;
}
