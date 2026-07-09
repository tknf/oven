CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`locked_at` integer,
	`failed_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL
);
