/**
 * Minimal Drizzle schema for verifying `createTestDb` (`src/test/db.ts`). Does not bring in any
 * real application schema (`src/` must never import application code), and defines only the
 * minimal tables needed to verify the migration path.
 *
 * `jobs`/`broadcasts`/`sessions`/`kvEntries`/`audits` call the default schema factories exposed
 * by each adapter file (`sqliteJobsTable`/`sqliteBroadcastsTable`/`sqliteSessionsTable`/
 * `sqliteKeyValueTable`/`sqliteAuditsTable`) as-is. This verifies the factory-produced default
 * schemas themselves through the migration generation/application path (the
 * `SQLiteJobRecordTable`/`SQLiteBroadcastRecordTable`/`SQLiteSessionRecordTable`/
 * `SQLiteKeyValueRecordTable`/`SQLiteAuditRecordTable` contracts are already checked with
 * `satisfies` on each factory's side).
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sqliteAuditsTable } from "../../../src/audit/index.js";
import { sqliteJobsTable } from "../../../src/jobs/index.js";
import { sqliteKeyValueTable } from "../../../src/kv/index.js";
import { sqliteBroadcastsTable } from "../../../src/realtime/index.js";
import { sqliteSessionsTable } from "../../../src/session/index.js";

export const publishers = sqliteTable("publishers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	contactEmail: text("contact_email").notNull(),
	status: text("status").notNull().default("active"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * Child table of `publishers`, added to verify `AdminResource#inlines()`
 * (tabular inline editing of a parent's related rows) against a real
 * parent/child pair.
 */
export const books = sqliteTable("books", {
	id: text("id").primaryKey(),
	publisherId: text("publisher_id")
		.notNull()
		.references(() => publishers.id),
	title: text("title").notNull(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

export const jobs = sqliteJobsTable();

export const broadcasts = sqliteBroadcastsTable();

export const sessions = sqliteSessionsTable();

export const kvEntries = sqliteKeyValueTable();

export const audits = sqliteAuditsTable();
