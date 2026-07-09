CREATE TABLE `publishers` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`contact_email` varchar(255) NOT NULL,
	`status` varchar(255) NOT NULL DEFAULT 'active',
	`created_at` bigint NOT NULL,
	`updated_at` bigint NOT NULL,
	CONSTRAINT `publishers_id` PRIMARY KEY(`id`)
);
