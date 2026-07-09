CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"payload" text NOT NULL,
	"run_at" bigint NOT NULL,
	"attempts" integer NOT NULL,
	"locked_at" bigint,
	"failed_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL
);
