CREATE TABLE "admin_totp_users" (
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
	"totp_secret" text,
	"totp_enabled_at" bigint,
	"totp_last_used_step" integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_totp_users_username_idx" ON "admin_totp_users" USING btree ("username");