CREATE TABLE `jobs` (
	`id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`payload` varchar(4096) NOT NULL,
	`run_at` bigint NOT NULL,
	`attempts` int NOT NULL,
	`locked_at` bigint,
	`failed_at` bigint,
	`last_error` varchar(2048),
	`created_at` bigint NOT NULL,
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`)
);
