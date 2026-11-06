function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function validCharacteristic(value) {
  // Preserve unfamiliar printed expressions too; the search layer checks numbers.
  return value === null || typeof value === 'string' && value.trim().length > 0
    && value.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Validate the entire sidecar before returning new card and face objects. */
export function attachSearchMetadata(cards, metadata, manifest) {
  const spec = manifest?.searchMetadata;
  if (!Array.isArray(cards) || !isRecord(metadata) || metadata.schemaVersion !== 1
      || manifest?.schemaVersion !== 1 || !isRecord(spec) || !isRecord(metadata.cards)
      || typeof spec.url !== 'string' || !spec.url.trim()
      || !Number.isSafeInteger(spec.bytes) || spec.bytes < 1) {
    throw new Error('卡牌检索补充数据格式不受支持');
  }
  if (typeof metadata.oracleDate !== 'string' || !metadata.oracleDate.trim()
      || !Number.isFinite(Date.parse(metadata.oracleDate))
      || metadata.oracleDate !== spec.oracleDate || metadata.oracleDate !== manifest.snapshot?.oracleDate) {
    throw new Error('卡牌检索补充数据与卡库快照日期不一致');
  }
  if (!Number.isSafeInteger(spec.cards) || spec.cards !== cards.length
      || Object.keys(metadata.cards).length !== cards.length
      || (manifest.counts?.cards != null && manifest.counts.cards !== cards.length)) {
    throw new Error('卡牌检索补充数据数量与卡库清单不一致');
  }
  if (!Number.isSafeInteger(spec.rankedCards) || spec.rankedCards < 0 || spec.rankedCards > cards.length) {
    throw new Error('卡牌检索补充数据的 EDHREC 排名数量无效');
  }
  const seen = new Set();
  let rankedCards = 0;
  for (const card of cards) {
    if (!isRecord(card) || typeof card.id !== 'string' || !card.id || seen.has(card.id)
        || !Object.hasOwn(metadata.cards, card.id)) {
      throw new Error('卡牌检索补充数据的卡牌身份覆盖不完整或存在重复');
    }
    seen.add(card.id);
    const row = metadata.cards[card.id];
    if (!isRecord(row) || row.edhrecRank !== null && (!Number.isSafeInteger(row.edhrecRank) || row.edhrecRank < 1)) {
      throw new Error('卡牌检索补充数据的 EDHREC 排名无效');
    }
    if (row.edhrecRank !== null) rankedCards++;
    if (!Array.isArray(card.faces) || !Array.isArray(row.faces) || row.faces.length !== card.faces.length || !row.faces.length) {
      throw new Error('卡牌检索补充数据的牌面数量与卡库不一致');
    }
    for (let index = 0; index < card.faces.length; index++) {
      const original = card.faces[index], face = row.faces[index];
      if (!isRecord(original) || !isRecord(face) || typeof original.name !== 'string'
          || !original.name || face.name !== original.name) {
        throw new Error('卡牌检索补充数据的牌面名称或顺序与卡库不一致');
      }
      if (!validCharacteristic(face.power) || !validCharacteristic(face.toughness)) {
        throw new Error('卡牌检索补充数据的攻击力或防御力格式无效');
      }
    }
  }
  if (rankedCards !== spec.rankedCards) throw new Error('卡牌检索补充数据的 EDHREC 排名数量与清单不一致');
  return cards.map(card => ({
    ...card,
    edhrecRank: metadata.cards[card.id].edhrecRank,
    faces: card.faces.map((face, index) => ({
      ...face,
      power: metadata.cards[card.id].faces[index].power,
      toughness: metadata.cards[card.id].faces[index].toughness
    }))
  }));
}
