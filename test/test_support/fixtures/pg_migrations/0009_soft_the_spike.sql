CREATE TABLE "admin_lockout_users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_superuser" boolean DEFAULT false NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"last_login_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_lockout_users_username_idx" ON "admin_lockout_users" USING btree ("username");