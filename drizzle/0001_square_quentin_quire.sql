DROP INDEX `catalog_cards_name`;--> statement-breakpoint
CREATE INDEX `catalog_cards_name` ON `catalog_cards` (`version`,`name_rank`,`id`,`commander_legal`,`identity_mask`,`color_mask`);