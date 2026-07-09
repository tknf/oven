/**
 * `KeyValueStore` backed by an injected arbitrary table on Drizzle
 * (sqlite-core). Ports the same approach (how the column contract is
 * accepted, typing via `AnySQLiteColumn`, upsert) used by
 * `SQLiteDatabaseSessionStorage` in `session/sqlite_database_session_storage.ts`
 * to `KeyValueStore` (§4.8).
 *
 * **Dialect-parallel implementation** (see `sqlite_model.ts`): the Postgres
 * version is implemented independently as `PgDatabaseKeyValueStore` in
 * `pg_database_key_value_store.ts`, and the MySQL version as
 * `MySqlDatabaseKeyValueStore` in `mysql_database_key_value_store.ts`
 * (since Drizzle's type system runs in parallel across dialects, no shared
 * abstraction is introduced; only the method vocabulary is shared).
 *
 * Both `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family
 * driver, though the type itself is driver-independent) and `table` are
 * constructor-injected. The column contract `table` must satisfy
 * (`SQLiteKeyValueRecordTable`):
 * - `key` (TEXT NOT NULL, expected PRIMARY KEY)
 * - `value` (TEXT NOT NULL)
 * - `expiresAt` (INTEGER, nullable): expiration time (epoch ms). `null`
 *   means "never expires"
 *
 * Actively running GC (cleanup) of expired rows is out of scope (same
 * decision as the `DatabaseSessionStorage` family — see the module JSDoc in
 * `sqlite_database_session_storage.ts`). `get` deletes an expired row on a
 * best-effort basis before returning `null`, but this is incidental cleanup
 * during a read, not a mechanism that actively seeks out and removes
 * unread expired rows.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, SQLiteTable, TableConfig } from "drizzle-orm/sqlite-core";
import { KeyValueStore } from "./key_value_store.js";

/**
 * Type of a Drizzle table holding the columns `SQLiteDatabaseKeyValueStore`
 * requires. Uses `AnySQLiteColumn` (the same approach as
 * `SQLiteSessionRecordTable`), and does not constrain the table name or any
 * other columns.
 */
export type SQLiteKeyValueRecordTable = SQLiteTable<TableConfig> & {
	key: AnySQLiteColumn<{ data: string; notNull: true }>;
	value: AnySQLiteColumn<{ data: string; notNull: true }>;
	expiresAt: AnySQLiteColumn<{ data: number; notNull: false }>;
};

/** `KeyValueStore` backed by an injected Drizzle sqlite-core table (see module doc). */
export class SQLiteDatabaseKeyValueStore extends KeyValueStore {
	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown>,
		private readonly table: SQLiteKeyValueRecordTable,
	) {
		super();
	}

	/** Returns the value for `key`, or `null` if missing or expired (see module doc). */
	async get(key: string): Promise<string | null> {
		const rows = await this.db
			.select({ value: this.table.value, expiresAt: this.table.expiresAt })
			.from(this.table)
			.where(eq(this.table.key, key));
		const row = rows[0];
		if (!row) return null;

		if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
			await this.db.delete(this.table).where(eq(this.table.key, key));
			return null;
		}

		return row.value;
	}

	/** Upserts `value` under `key`, optionally with a TTL in seconds. */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		const expiresAt = ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000;

		await this.db
			.insert(this.table)
			.values({ key, value, expiresAt })
			.onConflictDoUpdate({ target: this.table.key, set: { value, expiresAt } });
	}

	/** Deletes `key`. Does not throw if the key does not exist. */
	async delete(key: string): Promise<void> {
		await this.db.delete(this.table).where(eq(this.table.key, key));
	}
}

/**
 * Factory returning a default schema satisfying `SQLiteKeyValueRecordTable`.
 * The table name can be changed via the `tableName` argument (default
 * `"kv_entries"`). Migration generation is left to the application via
 * drizzle-kit (this factory only provides the schema definition).
 */
export const sqliteKeyValueTable = (tableName = "kv_entries") =>
	sqliteTable(
		tableName,
		{
			key: text("key").primaryKey(),
			value: text("value").notNull(),
			expiresAt: integer("expires_at"),
		},
		(t) => [
			/** Index for TTL GC (bulk deletion of rows whose `expires_at` is in the past). */
			index(`${tableName}_expires_at_idx`).on(t.expiresAt),
		],
	) satisfies SQLiteKeyValueRecordTable;
