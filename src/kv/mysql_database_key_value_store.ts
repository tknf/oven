/**
 * `KeyValueStore` backed by an injected arbitrary table on Drizzle
 * (mysql-core). This is a dialect-parallel implementation of the same
 * contract (including its design decisions, column contract, and the
 * decision not to run GC) as `SQLiteDatabaseKeyValueStore` in
 * `sqlite_database_key_value_store.ts` and `PgDatabaseKeyValueStore` in
 * `pg_database_key_value_store.ts` (see the JSDoc in `mysql_model.ts` for
 * the "dialect-parallel implementation" rationale).
 *
 * Both `db` (`MySqlDatabase<TQueryResult, TPreparedQueryHKT>`; both type
 * parameters are promoted onto the class — see the module JSDoc in
 * `mysql_database_session_storage.ts`) and `table` are constructor-injected.
 * The column contract `table` must satisfy (`MySqlKeyValueRecordTable`):
 * - `key` (TEXT/VARCHAR NOT NULL, expected PRIMARY KEY)
 * - `value` (TEXT NOT NULL)
 * - `expiresAt` (numeric `bigint` column holding epoch ms; nullable):
 *   `null` means "never expires"
 *
 * `set` upserts using mysql-core's `onDuplicateKeyUpdate` (which has no
 * `target`; see "upsert" in `mysql_model.ts`).
 *
 * The rationale for not running GC is the same as
 * `SQLiteDatabaseKeyValueStore` (see the module JSDoc in
 * `sqlite_database_key_value_store.ts`).
 */
import { eq } from "drizzle-orm";
import { bigint, index, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import type {
	AnyMySqlColumn,
	MySqlDatabase,
	MySqlQueryResultHKT,
	MySqlTable,
	PreparedQueryHKTBase,
	TableConfig,
} from "drizzle-orm/mysql-core";
import { KeyValueStore } from "./key_value_store.js";

/**
 * Type of a Drizzle table holding the columns `MySqlDatabaseKeyValueStore`
 * requires. Uses `AnyMySqlColumn` (the same approach as
 * `MySqlSessionRecordTable`), and does not constrain the table name or any
 * other columns.
 */
export type MySqlKeyValueRecordTable = MySqlTable<TableConfig> & {
	key: AnyMySqlColumn<{ data: string; notNull: true }>;
	value: AnyMySqlColumn<{ data: string; notNull: true }>;
	expiresAt: AnyMySqlColumn<{ data: number; notNull: false }>;
};

/** `KeyValueStore` backed by an injected Drizzle mysql-core table (see module doc). */
export class MySqlDatabaseKeyValueStore<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
> extends KeyValueStore {
	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT>,
		private readonly table: MySqlKeyValueRecordTable,
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
			.onDuplicateKeyUpdate({ set: { value, expiresAt } });
	}

	/** Deletes `key`. Does not throw if the key does not exist. */
	async delete(key: string): Promise<void> {
		await this.db.delete(this.table).where(eq(this.table.key, key));
	}
}

/**
 * Factory returning a default schema satisfying `MySqlKeyValueRecordTable`.
 * The table name can be changed via the `tableName` argument (default
 * `"kv_entries"`). Migration generation is left to the application via
 * drizzle-kit (this factory only provides the schema definition).
 */
export const mysqlKeyValueTable = (tableName = "kv_entries") =>
	mysqlTable(
		tableName,
		{
			key: varchar("key", { length: 255 }).primaryKey(),
			value: text("value").notNull(),
			expiresAt: bigint("expires_at", { mode: "number" }),
		},
		(t) => [
			/** Index for TTL GC (bulk deletion of rows whose `expires_at` is in the past). */
			index(`${tableName}_expires_at_idx`).on(t.expiresAt),
		],
	) satisfies MySqlKeyValueRecordTable;
