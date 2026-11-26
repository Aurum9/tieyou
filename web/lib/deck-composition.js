import { normalizeText } from './search.js';
import { canonicalTagSlug, visibleTagLabel, tagIncludedInAnalysis, getTagDescription } from './tag-vocabulary.js';

const item = (slug, label, children = []) => ({ slug, label, children });
export const COMPOSITION_ROLES = [
  item('ramp', '加速', [item('land-ramp','地加速'),item('mana-rock','饼'),item('mana-dork','加速人'),item('ritual','祭礼'),item('extra-land','额外下地'),item('cost-reducer','减费源')]),
  item('card-advantage', '卡牌访问', [
    item('draw','抽牌'),item('impulse','冲动'),item('impulsive-draw','冲动抓牌'),item('seek','寻找'),item('land-or-hand','下地或抓牌'),item('life-for-cards','生命换牌'),item('consult','翻至符合条件'),item('tome','巨著'),item('creature-engine','生物获牌引擎'),item('play-from-top','牌库顶使用'),item('nightveil-theft','偷用对手牌'),
  ]),
  item('removal','去除', [item('removal-creature','生物解'),item('removal-artifact','神器解'),item('removal-enchantment','结界解'),item('removal-planeswalker','鹏洛客解'),item('removal-land','地解'),item('removal-battle','战役解'),item('removal-permanent','永久物解')]),
  item('sweeper','扫场', [item('sweeper-one-sided','单向扫场')]),
  item('counterspell','反击', [item('counterspell-ability','异能康'),item('counterspell-soft','软康'),item('counterspell-free','零费康'),item('counterspell-reusable','可复用康')]),
  item('tutor','导师', [item('tutor-card','任意牌导师'),item('tutor-land','地导师'),item('tutor-creature','生物导师'),item('tutor-artifact','神器导师'),item('tutor-enchantment','结界导师'),item('tutor-instant','瞬间导师'),item('tutor-sorcery','法术导师')]),
  item('protection','保护', [item('protection-granted','赋予防护'),item('damage-prevention','防止伤害'),item('rescue','回手避险'),item('flicker','云移避险'),item('haven','放逐暂存'),item('cheat-death','假死'),item('protection-other','其他保护')]),
  item('recursion','坟场资源回收', [item('regrowth','回到手牌'),item('reanimate','回到战场'),item('gives-castable-from-graveyard','重新使用'),item('restock','洗回牌库')]),
  item('hate-graveyard','坟场针对', [item('sweeper-graveyard','清理坟墓场'),item('graveyard-seal','封锁坟墓场')]),
];
const accessRoots = ['draw','impulse','impulsive-draw','seek','land-or-hand','life-for-cards','consult','creature-engine','play-from-top','nightveil-theft'];
const granted = ['gives-hexproof','gives-indestructible','gives-protection','gives-shroud','gives-ward','gives-player-hexproof','gives-player-protection','gives-player-shroud'];
const nonLandTutors = ['tutor-card','tutor-creature','tutor-artifact','tutor-enchantment','tutor-instant','tutor-sorcery','tutor-planeswalker','tutor-battle','tutor-permanent','tutor-nonland','tutor-noncreature','tutor-legendary','tutor-color','tutor-mv'];
const descriptions = {
  ramp:'增加可用法术力，或减少其他咒语费用。',
  'card-advantage':'通过抓牌、选牌或使用新牌来取得更多卡牌选择。导师与坟场资源回收单独统计。',
  draw:'让你抓牌的效果，包括抓弃、弃抓和轮。',
  removal:'去除战场上的永久物。下级按能够处理的对象分类，一张牌可以处理多种对象。',
  'removal-creature':'能够去除战场上的生物。',
  'removal-artifact':'能够去除战场上的神器。',
  'removal-enchantment':'能够去除战场上的结界。',
  'removal-planeswalker':'能够去除战场上的鹏洛客。',
  'removal-land':'能够去除战场上的地。',
  'removal-battle':'能够去除战场上的战役。',
  'removal-permanent':'能够去除不限于某一类别的永久物。',
  sweeper:'一次清理一群或某类永久物的效果。',
  counterspell:'反击堆叠上的咒语或异能。',
  tutor:'定向搜寻牌库中的牌。排除找地地及常规找地加速；能搜任意地的效应仍计入。',
  'tutor-card':'可以搜寻任意类别的牌，不限于生物、地或其他指定类别。对应 tutor-card，别名 tutor-any。',
  'tutor-land':'搜寻功能地的能力。找地地与常规找地加速不计入；能搜任意地的加速牌同时计入导师与加速。',
  protection:'保护己方牌手或物件的效果。回手、云移、暂存和假死仅统计同时承担保护职能的牌。',
  'protection-granted':'给予辟邪、不灭、保护、帷幕或守护等防护能力。',
  'damage-prevention':'防止伤害的保护效果。',
  rescue:'将自己的物件移回手牌，以避开威胁；这里只列出同时承担保护职能的救援。',
  flicker:'放逐自己的物件并使其返回，以避开威胁；这里只列出同时承担保护职能的云移。',
  haven:'将自己的物件暂存于放逐区，稍后取回；这里只列出承担保护职能的暂存效果。',
  'cheat-death':'让生物死去时返回战场或手牌；这里只列出同时承担保护职能的假死效果。',
  'protection-other':'已承担保护职能，但未归入上述方式的牌。',
  recursion:'重新利用坟墓场中的牌。',
  regrowth:'将坟墓场中的牌移回手牌。',
  reanimate:'将坟墓场中的永久物牌移回战场。',
  'gives-castable-from-graveyard':'允许重新使用坟墓场中的牌，包括使用自身或其他牌。',
  restock:'将坟墓场中的牌移回牌库。',
  'hate-graveyard':'清理或限制对手的坟墓场资源。',
  'nightveil-theft':'从对手牌库放逐牌，并允许你使用那些牌。',
  'play-from-top':'允许你使用或施放牌库顶牌。',
  tome:'以神器持续取得牌张资源。只提供回收或导师能力的牌归入对应职能。',
};

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
    return { ...definition, label,description:descriptions[definition.slug] || getTagDescription(definition.slug) || definition.label,count:0,entryIds:[],children:definition.children.map(child => makeGroup(child,definition.slug)) };
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
    const tomeAccess=has('tome') && (ordinaryAccess || !has('regrowth') && !has('tutor'));
    const landTutor=has('tutor-land') && !has('fetchland') && (!has('tutor-land-basic') || has('tutor-land-any')) && (!has('land-ramp') || has('tutor-land-any'));
    const tutor=has('tutor') && (!has('tutor-land') || landTutor || any(nonLandTutors));
    const preventsForOthers=has('damage-prevention') && !has('damage-prevention-self');
    const protects=has('protection') || any(granted) || preventsForOthers;
    const protectionMethods=any(granted) || has('damage-prevention') || has('rescue') || has('flicker') || has('haven') || has('cheat-death');
    function matches(slug, parent) {
      if (slug === 'card-advantage') return ordinaryAccess || tomeAccess;
      if (slug === 'tome') return tomeAccess;
      if (slug === 'tutor') return tutor;
      if (slug === 'tutor-land' && parent === 'tutor') return landTutor;
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
      for (const child of group.children) if (visibleTagLabel(child.slug) || ['protection-granted','protection-other'].includes(child.slug)) collect(child,group.slug);
    }
    for (const group of output) collect(group);
  }
  return output;
}
