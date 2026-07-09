/**
 * Verifies `SQLiteDatabaseBroadcaster` (a `Broadcaster` implementation that
 * turns an RDB into a polling-based pub/sub; `src/realtime/
 * sqlite_database_broadcaster.ts`). Checks publish/subscribe behavior using
 * `createTestDb` (`src/test/db.ts`) and a minimal fixture schema dedicated to
 * this repository (the `broadcasts` table in
 * `test/test_support/fixtures/schema.ts`), the same approach as
 * `test/jobs/sqlite_database_job_queue.test.ts`.
 *
 * Because the polling loop combines a real timer (`setTimeout`) with async DB
 * queries, it does not mix well with fake timers (same reason as the
 * "run stops when the AbortSignal is aborted" test in
 * `sqlite_database_job_worker.test.ts`). Throughout this file, deliveries are awaited
 * using real timers plus a short `pollIntervalMs` (10ms) plus `vi.waitFor`.
 * Right after `subscribe`, a short grace period (`settle`) is inserted before
 * `publish` to let the "first poll while the cursor is uninitialized"
 * complete asynchronously. This avoids the inherent race where a message
 * would be swallowed by cursor initialization if subscribe and publish ran
 * nearly simultaneously, and lets each test's intent (delivered / not
 * delivered) be verified reliably.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createTestDb } from "../../src/test/db.js";
import type { BroadcastMessage } from "../../src/realtime/broadcaster.js";
import { SQLiteDatabaseBroadcaster } from "../../src/realtime/sqlite_database_broadcaster.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

/** Waits `ms` milliseconds of real time. A test-only helper to reliably span one polling cycle. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("SQLiteDatabaseBroadcaster", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	test("delivers published messages to subscribed listeners via polling", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		await broadcaster.publish("room:1", { data: "hello" });

		await vi.waitFor(() => expect(received).toEqual([{ data: "hello", event: undefined }]), {
			timeout: 2000,
			interval: 20,
		});
	});

	test("does not deliver messages published before subscribe (verifies cursor initialization)", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});

		await broadcaster.publish("room:1", { data: "before-subscribe" });

		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));

		await sleep(150);
		expect(received).toEqual([]);
	});

	test("delivers correctly to each of two subscribed channels and not to an unsubscribed channel", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const room1: BroadcastMessage[] = [];
		const room2: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => room1.push(message));
		broadcaster.subscribe("room:2", (message) => room2.push(message));
		await sleep(50);

		await broadcaster.publish("room:1", { data: "for-room-1" });
		await broadcaster.publish("room:2", { data: "for-room-2" });
		await broadcaster.publish("room:3", { data: "for-unsubscribed-room" });

		await vi.waitFor(
			() => {
				expect(room1).toEqual([{ data: "for-room-1", event: undefined }]);
				expect(room2).toEqual([{ data: "for-room-2", event: undefined }]);
			},
			{ timeout: 2000, interval: 20 },
		);

		await sleep(100);
		expect(room1).toHaveLength(1);
		expect(room2).toHaveLength(1);
	});

	test("does not deliver to a listener after unsubscribe", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const received: BroadcastMessage[] = [];
		const unsubscribe = broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		unsubscribe();
		await broadcaster.publish("room:1", { data: "after-unsubscribe" });

		await sleep(150);
		expect(received).toEqual([]);
	});

	test("unsubscribe is idempotent and does not throw when called twice", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const unsubscribe = broadcaster.subscribe("room:1", () => {});

		unsubscribe();
		expect(() => unsubscribe()).not.toThrow();
	});

	test("delivery to other listeners on the same channel continues even if a listener throws", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", () => {
			throw new Error("internal listener error");
		});
		broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		await broadcaster.publish("room:1", { data: "hello" });

		await vi.waitFor(() => expect(received).toEqual([{ data: "hello", event: undefined }]), {
			timeout: 2000,
			interval: 20,
		});
	});

	test("rows older than retentionSeconds are deleted on publish", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
			retentionSeconds: 1,
			gcInterval: 1,
		});

		await ctx.db.insert(schema.broadcasts).values({
			channel: "room:1",
			data: "stale",
			event: null,
			createdAt: Date.now() - 2000,
		});

		await broadcaster.publish("room:1", { data: "fresh" });

		const rows = await ctx.db.select().from(schema.broadcasts);
		expect(rows.map((row) => row.data)).toEqual(["fresh"]);
	});

	test("the same message is not delivered twice (verifies cursor advancement)", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		await broadcaster.publish("room:1", { data: "hello" });

		await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000, interval: 20 });

		await sleep(100);
		expect(received).toHaveLength(1);
	});

	test("does not fetch beyond pollLimit (cuts off at the limit and fetches the rest on the next poll)", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
			pollLimit: 2,
		});
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		await broadcaster.publish("room:1", { data: "1" });
		await broadcaster.publish("room:1", { data: "2" });
		await broadcaster.publish("room:1", { data: "3" });

		await vi.waitFor(() => expect(received).toHaveLength(3), { timeout: 2000, interval: 20 });
		expect(received.map((message) => message.data)).toEqual(["1", "2", "3"]);
	});

	test("GC delete does not run before gcInterval publishes and runs once the threshold is reached", async () => {
		const broadcaster = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
			retentionSeconds: 1,
			gcInterval: 3,
		});

		await ctx.db.insert(schema.broadcasts).values({
			channel: "room:1",
			data: "stale",
			event: null,
			createdAt: Date.now() - 2000,
		});

		await broadcaster.publish("room:1", { data: "1" });
		await broadcaster.publish("room:1", { data: "2" });

		let rows = await ctx.db.select().from(schema.broadcasts);
		expect(rows.map((row) => row.data)).toContain("stale");

		await broadcaster.publish("room:1", { data: "3" });

		rows = await ctx.db.select().from(schema.broadcasts);
		expect(rows.map((row) => row.data)).not.toContain("stale");
	});

	test("publish from one instance reaches a subscriber on another instance via the same db/table", async () => {
		const publisher = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const subscriber = new SQLiteDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const received: BroadcastMessage[] = [];
		subscriber.subscribe("room:1", (message) => received.push(message));
		await sleep(50);

		await publisher.publish("room:1", { data: "from-another-instance" });

		await vi.waitFor(
			() => expect(received).toEqual([{ data: "from-another-instance", event: undefined }]),
			{ timeout: 2000, interval: 20 },
		);
	});
});
