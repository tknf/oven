CREATE TABLE "broadcasts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"data" text NOT NULL,
	"event" text,
	"created_at" bigint NOT NULL
);
