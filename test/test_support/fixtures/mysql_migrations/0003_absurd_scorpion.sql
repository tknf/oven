CREATE TABLE `kv_entries` (
	`key` varchar(255) NOT NULL,
	`value` text NOT NULL,
	`expires_at` bigint,
	CONSTRAINT `kv_entries_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` varchar(255) NOT NULL,
	`data` text NOT NULL,
	`expires_at` bigint NOT NULL,
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `broadcasts` MODIFY COLUMN `data` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` MODIFY COLUMN `payload` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` MODIFY COLUMN `last_error` text;