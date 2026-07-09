CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`publisher_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`id`) ON UPDATE no action ON DELETE no action
);
