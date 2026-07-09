CREATE INDEX `audits_created_at_idx` ON `audits` (`created_at`);--> statement-breakpoint
CREATE INDEX `broadcasts_created_at_idx` ON `broadcasts` (`created_at`);--> statement-breakpoint
CREATE INDEX `broadcasts_channel_id_idx` ON `broadcasts` (`channel`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_priority_run_at_idx` ON `jobs` (`priority`,`run_at`);--> statement-breakpoint
CREATE INDEX `kv_entries_expires_at_idx` ON `kv_entries` (`expires_at`);--> statement-breakpoint
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);