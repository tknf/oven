CREATE TABLE `broadcasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`data` text NOT NULL,
	`event` text,
	`created_at` integer NOT NULL
);
