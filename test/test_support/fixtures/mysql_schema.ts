/**
 * Minimal MySQL (mysql-core) Drizzle schema for verifying `test/model/mysql_model.test.ts` and
 * `test/session/mysql_database_session_storage.test.ts`. A MySQL-dialect counterpart to the
 * SQLite `schema.ts` and Postgres `pg_schema.ts` (parallel implementations per dialect). Does not
 * bring in any real application schema (`src/` must never import application code), and defines
 * only the minimal single table needed to verify the migration path.
 *
 * `createdAt`/`updatedAt` store epoch ms (`Date.now()`, which needs 64-bit precision), so for the
 * same reason as the Postgres version this uses `bigint(..., { mode: "number" })` rather than
 * MySQL's 32-bit `int` (treated as a JS number; epoch ms never exceeds 2^53, so no precision is
 * lost).
 *
 * `jobs`/`broadcasts`/`sessions`/`kvEntries`/`audits`/`adminUsers`/`adminGroups`/
 * `adminUserGroups` call the default schema factories exposed by each adapter file
 * (`mysqlJobsTable`/`mysqlBroadcastsTable`/`mysqlSessionsTable`/`mysqlKeyValueTable`/
 * `mysqlAuditsTable`/`mysqlAdminUsersTable`/`mysqlAdminGroupsTable`/
 * `mysqlAdminUserGroupsTable`) as-is. This verifies the factory-produced default schemas
 * themselves through the migration generation/application path. The hand-written definitions (`payload`/`data` as
 * `varchar(4096)`, `lastError` as `varchar(2048)`) are unified into the default schema's `text`
 * columns (this column type change is intentional).
 */
import { bigint, mysqlTable, uniqueIndex, varchar } from "drizzle-orm/mysql-core";
/** Direct-file import (not `src/admin/index.js`): the admin index star-exports `.tsx` view modules, which drizzle-kit (which loads this schema) should not have to parse. */
import {
	mysqlAdminUserColumns,
	mysqlAdminUserLockoutColumns,
	mysqlAdminUserTotpColumns,
	mysqlAdminUsersTable,
} from "../../../src/admin/mysql_admin_accounts.js";
import {
	mysqlAdminGroupsTable,
	mysqlAdminUserGroupsTable,
} from "../../../src/admin/mysql_admin_groups.js";
import { mysqlAuditsTable } from "../../../src/audit/index.js";
import { mysqlJobsTable } from "../../../src/jobs/index.js";
import { mysqlKeyValueTable } from "../../../src/kv/index.js";
import { mysqlBroadcastsTable } from "../../../src/realtime/index.js";
import { mysqlSessionsTable } from "../../../src/session/index.js";

export const publishers = mysqlTable("publishers", {
	id: varchar("id", { length: 255 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	contactEmail: varchar("contact_email", { length: 255 }).notNull(),
	status: varchar("status", { length: 255 }).notNull().default("active"),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const jobs = mysqlJobsTable();

export const broadcasts = mysqlBroadcastsTable();

export const sessions = mysqlSessionsTable();

export const kvEntries = mysqlKeyValueTable();

export const audits = mysqlAuditsTable();

export const adminUsers = mysqlAdminUsersTable();

export const adminGroups = mysqlAdminGroupsTable();

export const adminUserGroups = mysqlAdminUserGroupsTable();

/**
 * Lockout-capable admin-user table verifying the documented lockout extension
 * recipe (spreading `mysqlAdminUserColumns()` and `mysqlAdminUserLockoutColumns()`
 * into an app-defined table) through the migration generation/application
 * path. A MySQL-dialect counterpart to the SQLite `adminLockoutUsers` fixture
 * table.
 */
export const adminLockoutUsers = mysqlTable(
	"admin_lockout_users",
	{
		...mysqlAdminUserColumns(),
		...mysqlAdminUserLockoutColumns(),
	},
	(t) => [uniqueIndex("admin_lockout_users_username_idx").on(t.username)],
);

/**
 * TOTP-capable admin-user table verifying the documented TOTP extension
 * recipe (spreading `mysqlAdminUserColumns()` and `mysqlAdminUserTotpColumns()`
 * into an app-defined table) through the migration generation/application
 * path. A MySQL-dialect counterpart to the SQLite `adminTotpUsers` fixture
 * table.
 */
export const adminTotpUsers = mysqlTable(
	"admin_totp_users",
	{
		...mysqlAdminUserColumns(),
		...mysqlAdminUserTotpColumns(),
	},
	(t) => [uniqueIndex("admin_totp_users_username_idx").on(t.username)],
);
