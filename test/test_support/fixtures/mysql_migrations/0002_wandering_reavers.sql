CREATE TABLE `broadcasts` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`channel` varchar(255) NOT NULL,
	`data` varchar(4096) NOT NULL,
	`event` varchar(255),
	`created_at` bigint NOT NULL,
	CONSTRAINT `broadcasts_id` PRIMARY KEY(`id`)
);
