CREATE TABLE `admin_groups` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`permissions` text NOT NULL,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `admin_groups_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_groups_name_idx` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `admin_user_groups` (
	`user_id` varchar(255) NOT NULL,
	`group_id` varchar(255) NOT NULL,
	`created_at` bigint NOT NULL,
	CONSTRAINT `admin_user_groups_user_id_group_id_pk` PRIMARY KEY(`user_id`,`group_id`)
);
--> statement-breakpoint
CREATE INDEX `admin_user_groups_group_id_idx` ON `admin_user_groups` (`group_id`);