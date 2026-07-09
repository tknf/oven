/**
 * `KeyValueStore` backed by an injected arbitrary table on Drizzle
 * (pg-core). This is a dialect-parallel implementation of the same contract
 * (including its design decisions, column contract, and the decision not to
 * run GC) as `SQLiteDatabaseKeyValueStore` in
 * `sqlite_database_key_value_store.ts` (see the JSDoc in `pg_model.ts` for
 * the "dialect-parallel implementation" rationale).
 *
 * Both `db` (`PgDatabase<TQueryResult, TSchema>`; `TQueryResult` is promoted
 * onto the class — see the module JSDoc in `pg_database_session_storage.ts`)
 * and `table` are constructor-injected. The column contract `table` must
 * satisfy (`PgKeyValueRecordTable`):
 * - `key` (TEXT NOT NULL, expected PRIMARY KEY)
 * - `value` (TEXT NOT NULL)
 * - `expiresAt` (numeric column holding epoch ms; nullable): `null` means
 *   "never expires". Uses `bigint(..., { mode: "number" })` since 64-bit
 *   precision is required (32-bit integer would be out of range — same
 *   reason as `createdAt`/`updatedAt` in `pg_model.ts`)
 *
 * The rationale for not running GC is the same as
 * `SQLiteDatabaseKeyValueStore` (see the module JSDoc in
 * `sqlite_database_key_value_store.ts`).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable, TableConfig } from "drizzle-orm/pg-core";
import { KeyValueStore } from "./key_value_store.js";

/**
 * Type of a Drizzle table holding the columns `PgDatabaseKeyValueStore`
 * requires. Uses `AnyPgColumn` (the same approach as `PgSessionRecordTable`),
 * and does not constrain the table name or any other columns.
 */
export type PgKeyValueRecordTable = PgTable<TableConfig> & {
	key: AnyPgColumn<{ data: string; notNull: true }>;
	value: AnyPgColumn<{ data: string; notNull: true }>;
	expiresAt: AnyPgColumn<{ data: number; notNull: false }>;
};

/** `KeyValueStore` backed by an injected Drizzle pg-core table (see module doc). */
export class PgDatabaseKeyValueStore<TQueryResult extends PgQueryResultHKT> extends KeyValueStore {
	constructor(
		private readonly db: PgDatabase<TQueryResult>,
		private readonly table: PgKeyValueRecordTable,
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
 * Factory returning a default schema satisfying `PgKeyValueRecordTable`.
 * The table name can be changed via the `tableName` argument (default
 * `"kv_entries"`). Migration generation is left to the application via
 * drizzle-kit (this factory only provides the schema definition).
 */
export const pgKeyValueTable = (tableName = "kv_entries") =>
	pgTable(
		tableName,
		{
			key: text("key").primaryKey(),
			value: text("value").notNull(),
			expiresAt: bigint("expires_at", { mode: "number" }),
		},
		(t) => [
			/** Index for TTL GC (bulk deletion of rows whose `expires_at` is in the past). */
			index(`${tableName}_expires_at_idx`).on(t.expiresAt),
		],
	) satisfies PgKeyValueRecordTable;
