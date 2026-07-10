/**
 * Minimal Drizzle schema for verifying `createTestDb` (`src/test/db.ts`). Does not bring in any
 * real application schema (`src/` must never import application code), and defines only the
 * minimal tables needed to verify the migration path.
 *
 * `jobs`/`broadcasts`/`sessions`/`kvEntries`/`audits`/`adminUsers`/`adminGroups`/
 * `adminUserGroups` call the default schema factories exposed by each adapter file
 * (`sqliteJobsTable`/`sqliteBroadcastsTable`/`sqliteSessionsTable`/`sqliteKeyValueTable`/
 * `sqliteAuditsTable`/`sqliteAdminUsersTable`/`sqliteAdminGroupsTable`/
 * `sqliteAdminUserGroupsTable`) as-is. This verifies the factory-produced default schemas
 * themselves through the migration generation/application path (the
 * `SQLiteJobRecordTable`/`SQLiteBroadcastRecordTable`/`SQLiteSessionRecordTable`/
 * `SQLiteKeyValueRecordTable`/`SQLiteAuditRecordTable`/`SQLiteAdminUserRecordTable`/
 * `SQLiteAdminGroupRecordTable`/`SQLiteAdminUserGroupRecordTable` contracts are already
 * checked with `satisfies` on each factory's side).
 */
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
/** Direct-file import (not `src/admin/index.js`): the admin index star-exports `.tsx` view modules, which drizzle-kit (which loads this schema) should not have to parse. */
import {
	sqliteAdminUserColumns,
	sqliteAdminUserLockoutColumns,
	sqliteAdminUserTotpColumns,
	sqliteAdminUsersTable,
} from "../../../src/admin/sqlite_admin_accounts.js";
import {
	sqliteAdminGroupsTable,
	sqliteAdminUserGroupsTable,
} from "../../../src/admin/sqlite_admin_groups.js";
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

export const adminUsers = sqliteAdminUsersTable();

export const adminGroups = sqliteAdminGroupsTable();

export const adminUserGroups = sqliteAdminUserGroupsTable();

/**
 * Extended admin-user table verifying the documented extension recipe (spreading
 * `sqliteAdminUserColumns()` into an app-defined table with extra columns) through
 * the migration generation/application path.
 */
export const adminOperators = sqliteTable(
	"admin_operators",
	{
		...sqliteAdminUserColumns(),
		email: text("email").notNull(),
	},
	(t) => [uniqueIndex("admin_operators_username_idx").on(t.username)],
);

/**
 * Lockout-capable admin-user table verifying the documented lockout extension
 * recipe (spreading `sqliteAdminUserColumns()` and `sqliteAdminUserLockoutColumns()`
 * into an app-defined table) through the migration generation/application path.
 */
export const adminLockoutUsers = sqliteTable(
	"admin_lockout_users",
	{
		...sqliteAdminUserColumns(),
		...sqliteAdminUserLockoutColumns(),
	},
	(t) => [uniqueIndex("admin_lockout_users_username_idx").on(t.username)],
);

/**
 * TOTP-capable admin-user table verifying the documented TOTP extension
 * recipe (spreading `sqliteAdminUserColumns()` and `sqliteAdminUserTotpColumns()`
 * into an app-defined table) through the migration generation/application
 * path, and backing the panel-level TOTP login flow tests
 * (`test/admin/admin_panel_accounts.test.ts`).
 */
export const adminTotpUsers = sqliteTable(
	"admin_totp_users",
	{
		...sqliteAdminUserColumns(),
		...sqliteAdminUserTotpColumns(),
	},
	(t) => [uniqueIndex("admin_totp_users_username_idx").on(t.username)],
);
