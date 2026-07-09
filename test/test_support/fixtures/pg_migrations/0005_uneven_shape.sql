CREATE TABLE "audits" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"changes" text,
	"created_at" bigint NOT NULL
);
