import { normalizeText } from './search.js';
import { canonicalTagSlug, visibleTagLabel, tagIncludedInAnalysis } from './tag-vocabulary.js';

const item = (slug, label, children = []) => ({ slug, label, children });
export const COMPOSITION_ROLES = [
  item('ramp', '加速', [item('land-ramp','地加速'),item('mana-rock','饼'),item('mana-dork','加速人'),item('ritual','祭礼'),item('extra-land','额外下地'),item('cost-reducer','减费源')]),
  item('card-advantage', '卡牌访问', [
    item('draw','抽牌', [item('pure-draw','纯粹抓牌'),item('loot','抓弃'),item('rummage','弃抓'),item('wheel','轮'),item('draw-engine','抓牌引擎'),item('burst-draw','爆发性抓牌'),item('cantrip','戏法'),item('plunder','牺牲抓牌'),item('brainstorm','脑力激荡效应')]),
    item('impulse','冲动'),item('impulsive-draw','冲动抓牌'),item('tutor','导师'),item('seek','寻找'),item('land-or-hand','下地或抓牌'),item('life-for-cards','生命换牌'),item('consult','翻至符合条件'),item('tome','巨著'),item('creature-engine','生物获牌引擎'),item('play-from-top','牌库顶使用'),item('nightveil-theft','偷用对手牌'),
  ]),
  item('removal','去除', [item('spot-removal','单解'),item('multi-removal','群解'),item('sweeper','扫场'),item('removal-creature','生物解'),item('removal-artifact','神器解'),item('removal-enchantment','结界解'),item('removal-planeswalker','鹏洛客解')]),
  item('sweeper','扫场', [item('sweeper-one-sided','单向扫场')]),
  item('counterspell','反击', [item('counterspell-ability','异能康'),item('counterspell-soft','软康'),item('counterspell-free','零费康'),item('counterspell-reusable','可复用康')]),
  item('tutor','导师', [item('tutor-land','地导师'),item('tutor-creature','生物导师'),item('tutor-artifact','神器导师'),item('tutor-enchantment','结界导师'),item('tutor-instant','瞬间导师'),item('tutor-sorcery','法术导师')]),
  item('protection','保护', [item('protection-granted','赋予防护'),item('damage-prevention','防止伤害'),item('rescue','回手避险'),item('flicker','云移避险'),item('haven','放逐暂存'),item('protection-other','其他保护')]),
  item('recursion','坟场资源回收', [item('regrowth','回到手牌'),item('reanimate','回到战场'),item('gives-castable-from-graveyard','重新使用'),item('restock','洗回牌库')]),
  item('hate-graveyard','坟场针对', [item('sweeper-graveyard','清理坟墓场'),item('graveyard-seal','封锁坟墓场')]),
];
const accessRoots = ['draw','impulse','impulsive-draw','tutor','seek','land-or-hand','life-for-cards','consult','creature-engine','play-from-top','nightveil-theft'];
const granted = ['gives-hexproof','gives-indestructible','gives-protection','gives-shroud','gives-ward','gives-player-hexproof','gives-player-protection','gives-player-shroud'];

export function analyzeDeckComposition(deck, cards, { tagVocabulary = [] } = {}) {
  const index = cards instanceof Map ? cards : new Map(cards.map(card => [card.id,card]));
  const vocabulary = new Map(tagVocabulary.map(tag => [tag.slug,tag]));
  const aliases = new Map(tagVocabulary.map(tag => [normalizeText(tag.slug),tag.slug]));
  for (const tag of tagVocabulary) for (const alias of tag.aliases || []) if (!aliases.has(normalizeText(alias))) aliases.set(normalizeText(alias),tag.slug);
  const ancestry = new Map();
  function ancestors(slug) {
    if (ancestry.has(slug)) return ancestry.get(slug);
    const seen = new Set(), pending = [slug];
    while (pending.length) { const next=pending.pop(); if (seen.has(next)) continue; seen.add(next); pending.push(...(vocabulary.get(next)?.parentSlugs || [])); }
    ancestry.set(slug,seen); return seen;
  }
  const output = COMPOSITION_ROLES.filter(role => tagIncludedInAnalysis(role.slug) && visibleTagLabel(role.slug)).map(role => makeGroup(role));
  function makeGroup(definition, parent) {
    const label = parent && !['recursion','protection'].includes(parent) ? visibleTagLabel(definition.slug) || definition.label : definition.label;
    return { ...definition, label,count:0,entryIds:[],children:definition.children.map(child => makeGroup(child,definition.slug)), ...(definition.slug === 'card-advantage' ? {repeatable:{count:0,entryIds:[]}} : {}) };
  }
  function add(group, entry) { group.count += entry.quantity; group.entryIds.push(entry.id); }
  for (const entry of deck.entries) {
    if (entry.zone === 'considering') continue;
    const card=index.get(entry.cardId); if (!card) continue;
    const tags=new Set();
    for (const raw of card.tags || []) {
      const value=normalizeText(typeof raw === 'string' ? raw : raw?.slug || raw?.name || raw?.id);
      const slug=canonicalTagSlug(aliases.get(value) || value);
      if (!visibleTagLabel(slug)) continue;
      for (const ancestor of ancestors(slug)) if (visibleTagLabel(ancestor)) tags.add(ancestor);
    }
    const has = slug => tags.has(slug), any = slugs => slugs.some(has);
    const ordinaryAccess=any(accessRoots);
    // Tome is a design family. Graveyard-return-only tomes supply recursion, not new access.
    const tomeAccess=has('tome') && (!has('regrowth') || ordinaryAccess);
    const preventsForOthers=has('damage-prevention') && !has('damage-prevention-self');
    const protects=has('protection') || any(granted) || preventsForOthers;
    const protectionMethods=any(granted) || has('damage-prevention') || has('rescue') || has('flicker') || has('haven');
    function matches(slug, parent) {
      if (slug === 'card-advantage') return ordinaryAccess || tomeAccess;
      if (slug === 'tome') return tomeAccess;
      if (slug === 'ramp') return has('ramp') || has('cost-reducer');
      if (slug === 'recursion') return has('recursion') || any(['regrowth','reanimate','restock','gives-castable-from-graveyard','castable-from-graveyard']);
      if (slug === 'gives-castable-from-graveyard' && parent === 'recursion') return has(slug) || has('castable-from-graveyard');
      if (slug === 'protection') return protects;
      if (slug === 'protection-granted') return any(granted);
      if (slug === 'protection-other') return protects && !protectionMethods;
      // Rescue, blink and haven only contribute to protection when the existing tags also establish that role.
      if (parent === 'protection') return protects && has(slug);
      return has(slug);
    }
    function collect(group, parent) {
      if (!matches(group.slug,parent)) return;
      add(group,entry);
      if (group.repeatable && has('repeatable-card-advantage')) add(group.repeatable,entry);
      for (const child of group.children) if (visibleTagLabel(child.slug) || ['protection-granted','protection-other'].includes(child.slug)) collect(child,group.slug);
    }
    for (const group of output) collect(group);
  }
  return output;
}
