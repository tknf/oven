/**
 * Minimal Postgres (pg-core) Drizzle schema for verifying `test/test_support/pg_db.test.ts`
 * (confirming the migration path), `test/model/pg_model.test.ts`, and
 * `test/session/pg_database_session_storage.test.ts`. A Postgres-dialect counterpart to the
 * SQLite `schema.ts` (parallel implementations per dialect). Does not bring in any real
 * application schema (`src/` must never import application code), and defines only the minimal
 * single table needed to verify the migration path.
 *
 * `createdAt`/`updatedAt` store epoch ms (`Date.now()`, which needs 64-bit precision), which
 * doesn't fit in Postgres's 32-bit `integer` (confirmed to raise
 * `value ... is out of range for type integer` when run against PGlite in `pg_model.test.ts`).
 * This uses `bigint(..., { mode: "number" })` (treated as a JS number; epoch ms never exceeds
 * 2^53, so no precision is lost). The SQLite `schema.ts` keeps `integer` because SQLite's
 * `INTEGER` column is SQLite's own variable-length integer (up to 8 bytes) and doesn't conflict
 * with JS's `number`.
 *
 * `jobs`/`broadcasts`/`sessions`/`kvEntries`/`audits`/`adminUsers`/`adminGroups`/
 * `adminUserGroups` call the default schema factories exposed by each adapter file
 * (`pgJobsTable`/`pgBroadcastsTable`/`pgSessionsTable`/`pgKeyValueTable`/`pgAuditsTable`/
 * `pgAdminUsersTable`/`pgAdminGroupsTable`/`pgAdminUserGroupsTable`) as-is. This verifies the
 * factory-produced default schemas themselves through the migration generation/application path.
 */
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
/** Direct-file import (not `src/admin/index.js`): the admin index star-exports `.tsx` view modules, which drizzle-kit (which loads this schema) should not have to parse. */
import { pgAdminUsersTable } from "../../../src/admin/pg_admin_accounts.js";
import { pgAdminGroupsTable, pgAdminUserGroupsTable } from "../../../src/admin/pg_admin_groups.js";
import { pgAuditsTable } from "../../../src/audit/index.js";
import { pgJobsTable } from "../../../src/jobs/index.js";
import { pgKeyValueTable } from "../../../src/kv/index.js";
import { pgBroadcastsTable } from "../../../src/realtime/index.js";
import { pgSessionsTable } from "../../../src/session/index.js";

export const publishers = pgTable("publishers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	contactEmail: text("contact_email").notNull(),
	status: text("status").notNull().default("active"),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const jobs = pgJobsTable();

export const broadcasts = pgBroadcastsTable();

export const sessions = pgSessionsTable();

export const kvEntries = pgKeyValueTable();

export const audits = pgAuditsTable();

export const adminUsers = pgAdminUsersTable();

export const adminGroups = pgAdminGroupsTable();

export const adminUserGroups = pgAdminUserGroupsTable();
