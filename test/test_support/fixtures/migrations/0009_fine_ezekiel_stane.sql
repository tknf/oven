CREATE TABLE `admin_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_groups_name_idx` ON `admin_groups` (`name`);--> statement-breakpoint
CREATE TABLE `admin_user_groups` (
	`user_id` text NOT NULL,
	`group_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `group_id`)
);
--> statement-breakpoint
CREATE INDEX `admin_user_groups_group_id_idx` ON `admin_user_groups` (`group_id`);