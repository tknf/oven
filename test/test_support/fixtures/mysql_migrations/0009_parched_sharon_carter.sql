CREATE TABLE `admin_lockout_users` (
	`id` varchar(255) NOT NULL,
	`username` varchar(255) NOT NULL,
	`password_hash` text NOT NULL,
	`label` text,
	`is_active` boolean NOT NULL DEFAULT true,
	`is_superuser` boolean NOT NULL DEFAULT false,
	`permissions` text NOT NULL,
	`last_login_at` bigint,
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	`failed_attempts` int NOT NULL DEFAULT 0,
	`locked_until` bigint,
	CONSTRAINT `admin_lockout_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_lockout_users_username_idx` UNIQUE(`username`)
);
