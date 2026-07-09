CREATE TABLE `audits` (
	`id` varchar(255) NOT NULL,
	`actor` varchar(255) NOT NULL,
	`action` varchar(255) NOT NULL,
	`target` varchar(255) NOT NULL,
	`changes` text,
	`created_at` bigint NOT NULL,
	CONSTRAINT `audits_id` PRIMARY KEY(`id`)
);
