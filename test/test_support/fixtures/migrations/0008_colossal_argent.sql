CREATE TABLE `admin_operators` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`label` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_superuser` integer DEFAULT false NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`email` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_operators_username_idx` ON `admin_operators` (`username`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`label` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_superuser` integer DEFAULT false NOT NULL,
	`permissions` text DEFAULT '[]' NOT NULL,
	`last_login_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_username_idx` ON `admin_users` (`username`);