CREATE TABLE `catalog_batches` (
	`version` text NOT NULL,
	`batch_id` text NOT NULL,
	`digest` text NOT NULL,
	`card_count` integer NOT NULL,
	PRIMARY KEY(`version`, `batch_id`)
);
--> statement-breakpoint
CREATE TABLE `catalog_cards` (
	`row_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`version` text NOT NULL,
	`id` text NOT NULL,
	`core_json` text NOT NULL,
	`summary_json` text NOT NULL,
	`name_rank` integer NOT NULL,
	`mana_value` real NOT NULL,
	`color_mask` integer NOT NULL,
	`identity_mask` integer NOT NULL,
	`commander_legal` integer NOT NULL,
	`translated` integer NOT NULL,
	`edhrec_rank` integer,
	`released_at` text NOT NULL,
	`name_text` text NOT NULL,
	`oracle_text` text NOT NULL,
	`type_text` text NOT NULL,
	`default_version_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_cards_identity_key` ON `catalog_cards` (`version`,`id`);--> statement-breakpoint
CREATE INDEX `catalog_cards_name` ON `catalog_cards` (`version`,`name_rank`);--> statement-breakpoint
CREATE INDEX `catalog_cards_mana` ON `catalog_cards` (`version`,`mana_value`,`name_rank`);--> statement-breakpoint
CREATE INDEX `catalog_cards_edhrec` ON `catalog_cards` (`version`,`edhrec_rank`,`name_rank`);--> statement-breakpoint
CREATE INDEX `catalog_cards_identity` ON `catalog_cards` (`version`,`identity_mask`);--> statement-breakpoint
CREATE TABLE `catalog_faces` (
	`version` text NOT NULL,
	`card_id` text NOT NULL,
	`face_index` integer NOT NULL,
	`power` real,
	`toughness` real,
	`type_text` text NOT NULL,
	PRIMARY KEY(`version`, `card_id`, `face_index`)
);
--> statement-breakpoint
CREATE TABLE `catalog_printings` (
	`version` text NOT NULL,
	`card_id` text NOT NULL,
	`id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text NOT NULL,
	`lang` text NOT NULL,
	`rarity` text NOT NULL,
	`payload_json` text NOT NULL,
	PRIMARY KEY(`version`, `card_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `catalog_printings_lookup` ON `catalog_printings` (`version`,`set_code`,`collector_number`,`lang`,`rarity`);--> statement-breakpoint
CREATE INDEX `catalog_printings_card` ON `catalog_printings` (`version`,`card_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `catalog_snapshots` (
	`version` text PRIMARY KEY NOT NULL,
	`meta_json` text NOT NULL,
	`status` text DEFAULT 'loading' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`active_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `catalog_tags` (
	`version` text NOT NULL,
	`card_id` text NOT NULL,
	`slug` text NOT NULL,
	PRIMARY KEY(`version`, `card_id`, `slug`)
);
--> statement-breakpoint
CREATE INDEX `catalog_tags_slug` ON `catalog_tags` (`version`,`slug`,`card_id`);--> statement-breakpoint
CREATE TABLE `catalog_types` (
	`version` text NOT NULL,
	`card_id` text NOT NULL,
	`face_index` integer NOT NULL,
	`term` text NOT NULL,
	PRIMARY KEY(`version`, `card_id`, `face_index`, `term`)
);
--> statement-breakpoint
CREATE INDEX `catalog_types_term` ON `catalog_types` (`version`,`term`,`card_id`,`face_index`);
--> statement-breakpoint
CREATE VIRTUAL TABLE catalog_fts USING fts5(name_grams,oracle_grams,type_grams,tokenize='unicode61',content='');
