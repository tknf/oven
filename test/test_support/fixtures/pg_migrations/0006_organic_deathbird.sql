CREATE INDEX "audits_created_at_idx" ON "audits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "broadcasts_created_at_idx" ON "broadcasts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "broadcasts_channel_id_idx" ON "broadcasts" USING btree ("channel","id");--> statement-breakpoint
CREATE INDEX "jobs_priority_run_at_idx" ON "jobs" USING btree ("priority","run_at");--> statement-breakpoint
CREATE INDEX "kv_entries_expires_at_idx" ON "kv_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");