CREATE TABLE `deck_libraries` (
	`account` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`library_json` text NOT NULL
);
