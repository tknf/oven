CREATE TABLE "admin_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user_groups" (
	"user_id" text NOT NULL,
	"group_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "admin_user_groups_user_id_group_id_pk" PRIMARY KEY("user_id","group_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "admin_groups_name_idx" ON "admin_groups" USING btree ("name");--> statement-breakpoint
CREATE INDEX "admin_user_groups_group_id_idx" ON "admin_user_groups" USING btree ("group_id");