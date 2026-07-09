CREATE TABLE "kv_entries" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"data" text NOT NULL,
	"expires_at" bigint NOT NULL
);
