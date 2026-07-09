/**
 * A `SessionStorage` backed by an arbitrary Drizzle (pg-core) table injected via the
 * constructor. This is a parallel dialect-specific implementation of the same
 * contract (including its design decisions, column contract, and decision not to
 * implement sliding TTL) as `SQLiteDatabaseSessionStorage` in
 * `sqlite_database_session_storage.ts`, targeting pg-core (see the JSDoc in
 * `pg_model.ts` for the "parallel dialect-specific implementation" approach).
 *
 * Only a session id (a 256-bit random hex string returned by `generateSessionId()`) is
 * kept in the cookie; the actual data is stored as a row in the injected table.
 *
 * Both `db` (`PgDatabase<TQueryResult, TSchema>` — `TQueryResult` is promoted to a
 * class type parameter; see the module JSDoc in `pg_model.ts`) and `table` are
 * injected via the constructor. The column contract `table` must satisfy
 * (`PgSessionRecordTable`):
 * - `id` (TEXT NOT NULL, expected PRIMARY KEY): the session id
 * - `data` (TEXT NOT NULL): `session.data` serialized via `JSON.stringify`
 * - `expiresAt` (a numeric column holding epoch ms, NOT NULL): the expiry time. If
 *   this has already passed at read time, treat it as expired (empty session)
 *
 * The reasons for not implementing sliding TTL and for keeping GC out of scope are
 * the same as for `SQLiteDatabaseSessionStorage` (see the module JSDoc in
 * `sqlite_database_session_storage.ts`).
 */
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import type { AnyPgColumn, PgTable, TableConfig } from "drizzle-orm/pg-core";
import { isSessionData, Session } from "./session.js";
import type { SessionCookieOptions } from "./session_storage.js";
import { generateSessionId, SessionStorage } from "./session_storage.js";

/**
 * The type of a Drizzle table that has the columns required by
 * `PgDatabaseSessionStorage`. Uses `AnyPgColumn` (the same idea as `AnySQLiteColumn`
 * in `SQLiteSessionRecordTable`) and does not care about the table name or any other
 * columns present.
 */
export type PgSessionRecordTable = PgTable<TableConfig> & {
	id: AnyPgColumn<{ data: string; notNull: true }>;
	data: AnyPgColumn<{ data: string; notNull: true }>;
	expiresAt: AnyPgColumn<{ data: number; notNull: true }>;
};

export type PgDatabaseSessionStorageOptions = SessionCookieOptions & {
	/** Session expiry in seconds. Defaults to 30 days. */
	ttlSeconds?: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

export class PgDatabaseSessionStorage<
	TQueryResult extends PgQueryResultHKT,
> extends SessionStorage {
	private readonly ttlSeconds: number;

	constructor(
		private readonly db: PgDatabase<TQueryResult>,
		private readonly table: PgSessionRecordTable,
		options: PgDatabaseSessionStorageOptions = {},
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

		const data = PgDatabaseSessionStorage.parseData(row.data);
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
 * Factory that returns a default schema satisfying `PgSessionRecordTable`. The table
 * name can be changed via the `tableName` argument (default `"sessions"`). Migration
 * generation is left to the application via drizzle-kit (this factory only provides
 * the schema definition).
 */
export const pgSessionsTable = (tableName = "sessions") =>
	pgTable(
		tableName,
		{
			id: text("id").primaryKey(),
			data: text("data").notNull(),
			expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/** Index for TTL GC (bulk deletion of rows whose `expires_at` is in the past). */
			index(`${tableName}_expires_at_idx`).on(t.expiresAt),
		],
	) satisfies PgSessionRecordTable;
