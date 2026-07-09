/**
 * A `Broadcaster` implementation that turns the RDB itself into a pub/sub.
 * Use this when you want to
 * resolve `InMemoryBroadcaster`'s limitation of "only reaches `publish` calls
 * within the same process" and make channel delivery work in multi-instance
 * environments (multi-process, multi-region). The decision to do this using
 * only the RDB the app already has, rather than adding a new middleware such as
 * Redis Pub/Sub, mirrors `SQLiteDatabaseJobQueue` in `jobs/sqlite_database_job_queue.ts`.
 *
 * The approach of injecting an arbitrary Drizzle (sqlite-core) table, the shape
 * of the column contract, typing via `AnySQLiteColumn`, and constructor
 * injection of db/table are the same conventions as `SQLiteDatabaseJobQueue`.
 * **Parallel per-dialect implementation** (see `sqlite_model.ts`): the Postgres
 * version is `PgDatabaseBroadcaster` in `pg_database_broadcaster.ts`, and the
 * MySQL version is `MySqlDatabaseBroadcaster` in `mysql_database_broadcaster.ts`,
 * each implemented independently (since Drizzle's type system runs in parallel
 * across dialects, no common abstraction is created; only method vocabulary and
 * algorithm are shared. `DatabaseBroadcasterOptions`/`DatabaseBroadcasterHooks`
 * are dialect-agnostic shapes, so they are exported from this file and imported
 * for reuse by the pg/mysql versions).
 *
 * Column contract that `table` must satisfy (`SQLiteBroadcastRecordTable`):
 * - `id` (INTEGER NOT NULL, `.primaryKey({ autoIncrement: true })`): a
 *   **monotonically increasing auto-incrementing integer PK**. Used as the
 *   polling cursor (`id > cursor`), so monotonicity is essential. Unlike
 *   `SQLiteModel`'s `IdGenerator` (Snowflake by default, string IDs), numbering
 *   is delegated to the DB here. Since broadcast messages are short-lived and
 *   GC'd (see below), there is no reason to follow `Model`'s string ID
 *   convention (needed for distributed numbering / time-sortability on
 *   long-lived data); with autoincrement, the cursor is simply `id > lastId`,
 *   keeping the implementation simple
 * - `channel` (TEXT NOT NULL)
 * - `data` (TEXT NOT NULL): `BroadcastMessage.data`
 * - `event` (TEXT, nullable): `BroadcastMessage.event`
 * - `createdAt` (INTEGER NOT NULL): enqueue time (epoch ms). An index is
 *   recommended since it's used for GC judgments (see below)
 *
 * **Delivery only performs GC as a side effect of `publish`** (proactive
 * periodic GC is out of scope, the same judgment as `SQLiteDatabaseSessionStorage`
 * in `session/sqlite_database_session_storage.ts`): after inserting a row,
 * `publish` deletes rows matching `createdAt < now - retentionSeconds * 1000`
 * only once every `gcInterval` calls (thinning it out to avoid the delete scan
 * piling up on every call under high-frequency `publish`).
 *
 * **No immediate delivery to local listeners (unified to polling across all
 * three dialects)**: an approach considered but not adopted was to fetch the
 * inserted row's `id` via `.returning()` and immediately deliver to listeners in
 * the same process while feeding the id back into the cursor to avoid double
 * delivery (SQLite/Postgres can get `id` via `.returning()`, but MySQL doesn't
 * support `RETURNING` and needs a separate path such as `$returningId()`).
 * Having "immediate within the same process, delayed elsewhere" behavior differ
 * by dialect would be confusing, so unifying behavior across all three dialects
 * was prioritized instead. As a result, **even delivery to the `listener` that
 * called `publish` within the same process is delayed until the next poll**,
 * just like delivery from other instances (up to `pollIntervalMs` plus query time).
 *
 * **Delivery guarantee is at-most-once** (per the `Broadcaster` base contract).
 * Arrival incurs a delay of up to `pollIntervalMs` plus query time. On runtimes
 * such as Cloudflare Workers where timers aren't kept alive outside of request
 * processing, note that polling only runs while the `broadcastSse`/
 * `BroadcastWebSocket` handler is alive (i.e. while the connection is open);
 * see `sse.ts` and `broadcast_web_socket.ts`.
 *
 * **Polling loop**: uses a recursive `setTimeout` approach (`setInterval` would
 * overlap if the previous query is slow; the same concern as the polling in
 * `sqlite_database_job_worker.ts`). Starts on the first `subscribe` and stops
 * and clears the timer once subscriptions reach zero. On each poll, if the
 * cursor is uninitialized, it only fetches `max(id)` to use as the cursor
 * (delivers nothing that round, so only messages after the `subscribe` point
 * are received); once initialized, it fetches rows matching
 * `id > cursor AND channel IN (subscribed channel set)` ordered by `id`
 * ascending, delivers them, and advances the cursor to the max delivered `id`.
 * If a query throws, `hooks.onPollError` is called and the loop continues
 * (exceptions from `listener` are swallowed and never propagate to other
 * listeners or the `publish` caller, per the `Broadcaster` base contract).
 */
import { and, asc, gt, inArray, lt, max } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type {
	AnySQLiteColumn,
	BaseSQLiteDatabase,
	SQLiteTable,
	TableConfig,
} from "drizzle-orm/sqlite-core";
import type { BroadcastMessage } from "./broadcaster.js";
import { Broadcaster } from "./broadcaster.js";

/**
 * Type of a Drizzle table having the columns `SQLiteDatabaseBroadcaster`
 * requires. Uses `AnySQLiteColumn` (the same idea as `SQLiteJobRecordTable`,
 * etc.), and does not care about the table name or any other column layout.
 */
export type SQLiteBroadcastRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: number; notNull: true }>;
	channel: AnySQLiteColumn<{ data: string; notNull: true }>;
	data: AnySQLiteColumn<{ data: string; notNull: true }>;
	event: AnySQLiteColumn<{ data: string; notNull: false }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

export type DatabaseBroadcasterOptions = {
	/** Polling interval (ms). Defaults to 1000. */
	pollIntervalMs?: number;
	/** Retention in seconds before delivered rows are cleaned up. Defaults to 60. */
	retentionSeconds?: number;
	/**
	 * Upper bound on the number of rows fetched per poll. Defaults to 1000.
	 * Prevents a single query from fetching a huge number of rows and putting
	 * load on memory/CPU when polling stalls or `publish` spikes (PER-006). If
	 * the fetched row count exactly equals this limit, it is treated as "there
	 * may be more", and the next poll runs immediately without waiting for
	 * `pollIntervalMs` (see `pollOnce`). Since the cursor only advances by what
	 * was fetched, any remainder beyond the limit naturally carries over to the
	 * next poll.
	 */
	pollLimit?: number;
	/**
	 * How often GC (deleting old rows as a side effect of `publish`) runs.
	 * Counts the number of `publish` calls and runs GC once every time this
	 * count is reached, then resets the counter. Defaults to 100. Thins out the
	 * `created_at` delete scan that would otherwise run on every high-frequency
	 * `publish` call (PER-005).
	 */
	gcInterval?: number;
};

/** Optional hooks for bridging polling events to logging, etc. */
export type DatabaseBroadcasterHooks = {
	/** Called when the polling DB query throws (the loop continues). */
	onPollError?: (error: unknown) => void;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_RETENTION_SECONDS = 60;
const DEFAULT_POLL_LIMIT = 1000;
const DEFAULT_GC_INTERVAL = 100;

type Listener = (message: BroadcastMessage) => void;

export class SQLiteDatabaseBroadcaster<
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
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: SQLiteBroadcastRecordTable,
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
	 * calls, also deletes rows older than `retentionSeconds` (see module JSDoc
	 * "GC"; thinned out per PER-005 instead of running every time). Does not
	 * immediately deliver to local `listener`s (see module JSDoc "unified to
	 * polling"; delivery happens on the next poll).
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
	 * polling loop (see module JSDoc "Polling loop"); it stops once subscriptions
	 * reach zero. The returned function is idempotent (subsequent calls do
	 * nothing).
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

	/**
	 * Resets the cursor to the uninitialized state and starts polling. The
	 * cursor reset is so that when subscriptions reach zero and stop, and then
	 * `subscribe` is called again, "only receive messages after this restart
	 * point" holds from that resumption point.
	 */
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
	 * Runs a single poll, and regardless of whether an error was reported to
	 * `hooks.onPollError`, schedules the next poll as long as subscriptions
	 * remain (so a throwing query doesn't stop the loop). If `pollOnce` reports
	 * "fetched exactly `pollLimit` rows, so there may be more", the next poll
	 * runs immediately (delay 0) instead of waiting for `pollIntervalMs`
	 * (PER-006: drain the backlog quickly instead of letting it build up).
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
	 * If the cursor is uninitialized, only fetches `max(id)` and stops there to
	 * use as the baseline going forward (see module JSDoc "Polling loop"). Once
	 * initialized, fetches up to `pollLimit` new rows for the subscribed
	 * channels ordered by `id` ascending (PER-006), delivers each row to that
	 * channel's `listener`s, and advances the cursor. Returns whether the
	 * fetched row count exactly equalled `pollLimit` (i.e. whether there may be more).
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
 * Factory that returns the default schema satisfying `SQLiteBroadcastRecordTable`.
 * The table name can be changed via the `tableName` argument (defaults to
 * `"broadcasts"`). Migration generation is left to the app via drizzle-kit
 * (this factory only provides the schema definition).
 */
export const sqliteBroadcastsTable = (tableName = "broadcasts") =>
	sqliteTable(
		tableName,
		{
			id: integer("id").primaryKey({ autoIncrement: true }),
			channel: text("channel").notNull(),
			data: text("data").notNull(),
			event: text("event"),
			createdAt: integer("created_at").notNull(),
		},
		(t) => [
			/** Index for `publish`'s GC (deleting old `created_at` rows). */
			index(`${tableName}_created_at_idx`).on(t.createdAt),
			/** Composite index for the polling SELECT (`id > cursor AND channel IN (...)`). */
			index(`${tableName}_channel_id_idx`).on(t.channel, t.id),
		],
	) satisfies SQLiteBroadcastRecordTable;
