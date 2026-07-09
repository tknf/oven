/**
 * A `SessionStorage` backed by an arbitrary Drizzle (sqlite-core) table injected via
 * the constructor. Only a session id (a 256-bit random hex string returned by
 * `generateSessionId()`) is kept in the cookie; the actual data is stored as a row in
 * the injected table.
 *
 * **Parallel dialect-specific implementation** (see `sqlite_model.ts`): the Postgres
 * counterpart is implemented independently as `PgDatabaseSessionStorage` in
 * `pg_database_session_storage.ts` (no shared abstraction is created, since Drizzle's
 * type system is itself parallel across dialects).
 *
 * Both `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family driver, but
 * the type itself is driver-agnostic) and `table` are injected via the constructor.
 * The column contract `table` must satisfy (`SQLiteSessionRecordTable`):
 * - `id` (TEXT NOT NULL, expected PRIMARY KEY): the session id
 * - `data` (TEXT NOT NULL): `session.data` serialized via `JSON.stringify`
 * - `expiresAt` (INTEGER NOT NULL): the expiry time (epoch ms). If this has already
 *   passed at read time, treat it as expired (empty session)
 *
 * **Decision to not support sliding TTL**: the "carry `refreshedAt` inside the value"
 * approach is specific to `KeyValueSessionStorage`'s requirements (avoiding a
 * dependency on Cloudflare KV's `getWithMetadata`). For DB backends, only the column
 * contract of `id`/`data`/`expiresAt` is provided. While running `UPDATE ... SET
 * expires_at = ?` on every request is less of a concern for a DB than for KV,
 * implementing unconditional sliding refresh would still be adding functionality that
 * was not requested, so it is not implemented here (TTL is fixed; the constructor
 * shape is kept aligned so the same threshold-based approach as
 * `KeyValueSessionStorage` could be added later if needed). Deleting expired rows
 * (GC) is likewise kept out of scope for the same reason.
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, SQLiteTable, TableConfig } from "drizzle-orm/sqlite-core";
import { isSessionData, Session } from "./session.js";
import type { SessionCookieOptions } from "./session_storage.js";
import { generateSessionId, SessionStorage } from "./session_storage.js";

/**
 * The type of a Drizzle table that has the columns required by
 * `SQLiteDatabaseSessionStorage`. Uses `AnySQLiteColumn` (a type drizzle-orm provides
 * so it can accept columns of a specific type from any schema — the same "accepting
 * interface not tied to a concrete schema" idea as in `id_generator.ts`) and does not
 * care about the table name or any other columns present.
 */
export type SQLiteSessionRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: string; notNull: true }>;
	data: AnySQLiteColumn<{ data: string; notNull: true }>;
	expiresAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

export type SQLiteDatabaseSessionStorageOptions = SessionCookieOptions & {
	/** Session expiry in seconds. Defaults to 30 days. */
	ttlSeconds?: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export class SQLiteDatabaseSessionStorage extends SessionStorage {
	private readonly ttlSeconds: number;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown>,
		private readonly table: SQLiteSessionRecordTable,
		options: SQLiteDatabaseSessionStorageOptions = {},
	) {
		const { ttlSeconds, ...cookieOptions } = options;
		super(cookieOptions);
		this.ttlSeconds = ttlSeconds ?? DEFAULT_TTL_SECONDS;
	}

	async get(cookieHeader: string | null): Promise<Session> {
		const id = this.readSessionCookie(cookieHeader);
		if (!id) return new Session("");

		const rows = await this.db
			.select({ id: this.table.id, data: this.table.data, expiresAt: this.table.expiresAt })
			.from(this.table)
			.where(eq(this.table.id, id));
		const row = rows[0];
		if (!row) return new Session("");

		if (row.expiresAt <= Date.now()) return new Session("");

		const data = SQLiteDatabaseSessionStorage.parseData(row.data);
		return data ? new Session(id, data) : new Session("");
	}

	/**
	 * When `session.needsRegeneration` is set, issues a new id as a defense against
	 * session fixation attacks, deletes the row under the old id, and saves under
	 * the new id (never leaving the old id behind).
	 */
	async commit(session: Session): Promise<string> {
		const oldId = session.id;
		const id = session.needsRegeneration || !oldId ? generateSessionId() : oldId;
		const expiresAt = Date.now() + this.ttlSeconds * 1000;
		const data = JSON.stringify(session.data);

		if (session.needsRegeneration && oldId) {
			await this.db.delete(this.table).where(eq(this.table.id, oldId));
		}
		await this.db
			.insert(this.table)
			.values({ id, data, expiresAt })
			.onConflictDoUpdate({ target: this.table.id, set: { data, expiresAt } });
		session.acknowledgeRegeneration();

		return this.buildCommitCookie(id);
	}

	async destroy(session: Session): Promise<string> {
		if (session.id) await this.db.delete(this.table).where(eq(this.table.id, session.id));

		return this.buildDestroyCookie();
	}

	private static parseData(raw: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = JSON.parse(raw);
			return isSessionData(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
}

/**
 * Factory that returns a default schema satisfying `SQLiteSessionRecordTable`. The
 * table name can be changed via the `tableName` argument (default `"sessions"`).
 * Migration generation is left to the application via drizzle-kit (this factory
 * only provides the schema definition).
 */
export const sqliteSessionsTable = (tableName = "sessions") =>
	sqliteTable(
		tableName,
		{
			id: text("id").primaryKey(),
			data: text("data").notNull(),
			expiresAt: integer("expires_at").notNull(),
		},
		(t) => [
			/** Index for TTL GC (bulk deletion of rows whose `expires_at` is in the past). */
			index(`${tableName}_expires_at_idx`).on(t.expiresAt),
		],
	) satisfies SQLiteSessionRecordTable;
