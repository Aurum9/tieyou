import { integer, sqliteTable, text, primaryKey, index, uniqueIndex, real } from 'drizzle-orm/sqlite-core';

export const catalogSnapshots = sqliteTable('catalog_snapshots', {
  version: text('version').primaryKey(),
  metaJson: text('meta_json').notNull(),
  status: text('status').notNull().default('loading'),
});
export const catalogState = sqliteTable('catalog_state', {
  id: integer('id').primaryKey(), activeVersion: text('active_version').notNull(),
});
export const catalogBatches = sqliteTable('catalog_batches', {
  version: text('version').notNull(), batchId: text('batch_id').notNull(), digest: text('digest').notNull(),
  cardCount: integer('card_count').notNull(),
}, t => [primaryKey({ columns: [t.version, t.batchId] })]);
export const catalogCards = sqliteTable('catalog_cards', {
  rowId: integer('row_id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull(), id: text('id').notNull(), coreJson: text('core_json').notNull(), summaryJson: text('summary_json').notNull(),
  nameRank: integer('name_rank').notNull(), manaValue: real('mana_value').notNull(), colorMask: integer('color_mask').notNull(), identityMask: integer('identity_mask').notNull(),
  commanderLegal: integer('commander_legal').notNull(), translated: integer('translated').notNull(), edhrecRank: integer('edhrec_rank'), releasedAt: text('released_at').notNull(),
  nameText: text('name_text').notNull(), oracleText: text('oracle_text').notNull(), typeText: text('type_text').notNull(),
  defaultVersionId: text('default_version_id'),
}, t => [uniqueIndex('catalog_cards_identity_key').on(t.version, t.id), index('catalog_cards_name').on(t.version, t.nameRank, t.id, t.commanderLegal, t.identityMask, t.colorMask), index('catalog_cards_mana').on(t.version, t.manaValue, t.nameRank), index('catalog_cards_edhrec').on(t.version, t.edhrecRank, t.nameRank), index('catalog_cards_identity').on(t.version, t.identityMask)]);
export const catalogFaces = sqliteTable('catalog_faces', {
  version: text('version').notNull(), cardId: text('card_id').notNull(), faceIndex: integer('face_index').notNull(), power: real('power'), toughness: real('toughness'), typeText: text('type_text').notNull(),
}, t => [primaryKey({ columns: [t.version, t.cardId, t.faceIndex] })]);
export const catalogPrintings = sqliteTable('catalog_printings', {
  version: text('version').notNull(), cardId: text('card_id').notNull(), id: text('id').notNull(), ordinal: integer('ordinal').notNull(),
  setCode: text('set_code').notNull(), collectorNumber: text('collector_number').notNull(), lang: text('lang').notNull(), rarity: text('rarity').notNull(), payloadJson: text('payload_json').notNull(),
}, t => [primaryKey({ columns: [t.version, t.cardId, t.id] }), index('catalog_printings_lookup').on(t.version, t.setCode, t.collectorNumber, t.lang, t.rarity), index('catalog_printings_card').on(t.version, t.cardId, t.ordinal)]);
export const catalogTags = sqliteTable('catalog_tags', {
  version: text('version').notNull(), cardId: text('card_id').notNull(), slug: text('slug').notNull(),
}, t => [primaryKey({ columns: [t.version, t.cardId, t.slug] }), index('catalog_tags_slug').on(t.version, t.slug, t.cardId)]);
export const catalogTypes = sqliteTable('catalog_types', {
  version: text('version').notNull(), cardId: text('card_id').notNull(), faceIndex: integer('face_index').notNull(), term: text('term').notNull(),
}, t => [primaryKey({ columns: [t.version, t.cardId, t.faceIndex, t.term] }), index('catalog_types_term').on(t.version, t.term, t.cardId, t.faceIndex)]);
