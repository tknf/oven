/**
 * Postgres (pg-core) counterpart of the `Broadcaster` implementation that turns
 * the RDB itself into a pub/sub. This is a parallel implementation for pg-core
 * with the same contract
 * (column contract, GC, polling algorithm, JSDoc structure) as
 * `SQLiteDatabaseBroadcaster` in `sqlite_database_broadcaster.ts` (parallel
 * per-dialect implementation; see the JSDoc in `pg_model.ts`).
 *
 * Both `db` (`PgDatabase<TQueryResult, TSchema>`; see the module JSDoc in
 * `pg_model.ts` for why `TQueryResult` is promoted to a class type parameter)
 * and `table` are injected via the constructor. The column contract `table`
 * must satisfy (`PgBroadcastRecordTable`) uses the same column names and
 * meanings as `SQLiteBroadcastRecordTable`, but `id` uses
 * `bigserial(..., { mode: "number" })` (Postgres's auto-numbering, the Postgres
 * counterpart of `SQLiteBroadcastRecordTable`'s
 * `.primaryKey({ autoIncrement: true })`):
 * - `id` (bigserial mode number, PRIMARY KEY): the polling cursor. See the
 *   module JSDoc in `sqlite_database_broadcaster.ts` for why a monotonically
 *   increasing auto-incrementing PK is used
 * - `channel` (TEXT NOT NULL)
 * - `data` (TEXT NOT NULL): `BroadcastMessage.data`
 * - `event` (TEXT, nullable): `BroadcastMessage.event`
 * - `createdAt` (bigint mode number, NOT NULL): enqueue time (epoch ms; a
 *   32-bit `integer` would be out of range, hence `bigint`)
 *
 * Why GC and immediate delivery to local listeners are skipped (unified across
 * all three dialects), the delivery guarantee, and the polling loop algorithm
 * are all identical to the module JSDoc in `sqlite_database_broadcaster.ts`.
 * `DatabaseBroadcasterOptions`/`DatabaseBroadcasterHooks` are dialect-agnostic
 * types, so they are imported and reused from `sqlite_database_broadcaster.ts`
 * (not redefined here).
 */
import { and, asc, gt, inArray, lt, max } from "drizzle-orm";
import { bigint, bigserial, index, pgTable, text } from "drizzle-orm/pg-core";
import type {
	AnyPgColumn,
	PgDatabase,
	PgQueryResultHKT,
	PgTable,
	TableConfig,
} from "drizzle-orm/pg-core";
import type { BroadcastMessage } from "./broadcaster.js";
import { Broadcaster } from "./broadcaster.js";
import type {
	DatabaseBroadcasterHooks,
	DatabaseBroadcasterOptions,
} from "./sqlite_database_broadcaster.js";

export type { DatabaseBroadcasterHooks, DatabaseBroadcasterOptions };

/**
 * Type of a Drizzle table having the columns `PgDatabaseBroadcaster` requires.
 * Uses `AnyPgColumn` (the same idea as `PgJobRecordTable`, etc.), and does not
 * care about the table name or any other column layout.
 */
export type PgBroadcastRecordTable = PgTable<TableConfig> & {
	id: AnyPgColumn<{ data: number; notNull: true }>;
	channel: AnyPgColumn<{ data: string; notNull: true }>;
	data: AnyPgColumn<{ data: string; notNull: true }>;
	event: AnyPgColumn<{ data: string; notNull: false }>;
	createdAt: AnyPgColumn<{ data: number; notNull: true }>;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETENTION_SECONDS = 60;
const DEFAULT_POLL_LIMIT = 1000;
const DEFAULT_GC_INTERVAL = 100;

type Listener = (message: BroadcastMessage) => void;

export class PgDatabaseBroadcaster<
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends Broadcaster {
	private readonly pollIntervalMs: number;
	private readonly retentionSeconds: number;
	private readonly pollLimit: number;
	private readonly gcInterval: number;
	private readonly hooks: DatabaseBroadcasterHooks;

	private readonly listenersByChannel = new Map<string, Set<Listener>>();
	private polling = false;
	private cursor: number | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private publishCount = 0;

	constructor(
		private readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly table: PgBroadcastRecordTable,
		options: DatabaseBroadcasterOptions = {},
		hooks: DatabaseBroadcasterHooks = {},
	) {
		super();
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.retentionSeconds = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
		this.pollLimit = options.pollLimit ?? DEFAULT_POLL_LIMIT;
		this.gcInterval = options.gcInterval ?? DEFAULT_GC_INTERVAL;
		this.hooks = hooks;
	}

	/**
	 * Inserts one row for `message` into `channel`. Once every `gcInterval`
	 * calls, also deletes rows older than `retentionSeconds` (identical
	 * algorithm to `sqlite_database_broadcaster.ts`; thinned out per PER-005
	 * instead of running every time). Does not immediately deliver to local
	 * `listener`s (see module JSDoc; delivery happens on the next poll).
	 */
	async publish(channel: string, message: BroadcastMessage): Promise<void> {
		const now = Date.now();
		await this.db.insert(this.table).values({
			channel,
			data: message.data,
			event: message.event ?? null,
			createdAt: now,
		});

		this.publishCount += 1;
		if (this.publishCount < this.gcInterval) return;
		this.publishCount = 0;

		await this.db
			.delete(this.table)
			.where(lt(this.table.createdAt, now - this.retentionSeconds * 1000));
	}

	/**
	 * Starts subscribing to `channel`. The first `subscribe` call starts the
	 * polling loop; it stops once subscriptions reach zero (same contract as
	 * `sqlite_database_broadcaster.ts`). The returned function is idempotent
	 * (subsequent calls do nothing).
	 */
	subscribe(channel: string, listener: Listener): () => void {
		let listeners = this.listenersByChannel.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.listenersByChannel.set(channel, listeners);
		}
		listeners.add(listener);

		if (!this.polling) this.startPolling();

		let unsubscribed = false;
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;

			listeners.delete(listener);
			if (listeners.size === 0) this.listenersByChannel.delete(channel);
			if (this.listenersByChannel.size === 0) this.stopPolling();
		};
	}

	/** Same contract as the like-named method in `sqlite_database_broadcaster.ts` (resets the cursor and starts). */
	private startPolling(): void {
		this.polling = true;
		this.cursor = undefined;
		this.scheduleNextPoll(0);
	}

	private stopPolling(): void {
		this.polling = false;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private scheduleNextPoll(delayMs: number): void {
		this.timer = setTimeout(() => {
			void this.poll();
		}, delayMs);
	}

	/**
	 * Same contract as the like-named method in `sqlite_database_broadcaster.ts`
	 * (errors are reported to `hooks.onPollError` while the loop continues; if
	 * `pollOnce` reports "there may be more", the next poll runs immediately
	 * instead of waiting for `pollIntervalMs`. PER-006).
	 */
	private async poll(): Promise<void> {
		let hasMore = false;
		try {
			hasMore = await this.pollOnce();
		} catch (error) {
			this.hooks.onPollError?.(error);
		}

		if (this.polling) this.scheduleNextPoll(hasMore ? 0 : this.pollIntervalMs);
	}

	/**
	 * Same algorithm as the like-named method in `sqlite_database_broadcaster.ts`.
	 * Fetches up to `pollLimit` rows (PER-006), and returns whether the fetched
	 * row count exactly equalled `pollLimit`.
	 */
	private async pollOnce(): Promise<boolean> {
		if (this.cursor === undefined) {
			const [row] = await this.db.select({ maxId: max(this.table.id) }).from(this.table);
			this.cursor = row?.maxId ?? 0;
			return false;
		}

		const channels = [...this.listenersByChannel.keys()];
		if (channels.length === 0) return false;

		const rows = await this.db
			.select({
				id: this.table.id,
				channel: this.table.channel,
				data: this.table.data,
				event: this.table.event,
			})
			.from(this.table)
			.where(and(gt(this.table.id, this.cursor), inArray(this.table.channel, channels)))
			.orderBy(asc(this.table.id))
			.limit(this.pollLimit);

		for (const row of rows) {
			this.cursor = row.id;
			this.dispatch(row.channel, { data: row.data, event: row.event ?? undefined });
		}

		return rows.length === this.pollLimit;
	}

	/** Calls every listener of `channel`. Exceptions inside a listener are swallowed (per the `Broadcaster` base contract). */
	private dispatch(channel: string, message: BroadcastMessage): void {
		const listeners = this.listenersByChannel.get(channel);
		if (!listeners) return;

		for (const listener of listeners) {
			try {
				listener(message);
			} catch {
				// Exceptions inside a listener must not propagate to publish or other listeners (Broadcaster base contract)
			}
		}
	}
}

/**
 * Factory that returns the default schema satisfying `PgBroadcastRecordTable`.
 * The table name can be changed via the `tableName` argument (defaults to
 * `"broadcasts"`). Migration generation is left to the app via drizzle-kit
 * (this factory only provides the schema definition).
 */
export const pgBroadcastsTable = (tableName = "broadcasts") =>
	pgTable(
		tableName,
		{
			id: bigserial("id", { mode: "number" }).primaryKey(),
			channel: text("channel").notNull(),
			data: text("data").notNull(),
			event: text("event"),
			createdAt: bigint("created_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/** Index for `publish`'s GC (deleting old `created_at` rows). */
			index(`${tableName}_created_at_idx`).on(t.createdAt),
			/** Composite index for the polling SELECT (`id > cursor AND channel IN (...)`). */
			index(`${tableName}_channel_id_idx`).on(t.channel, t.id),
		],
	) satisfies PgBroadcastRecordTable;
