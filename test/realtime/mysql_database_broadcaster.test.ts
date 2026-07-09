/**
 * Verifies `MySqlDatabaseBroadcaster` (the MySQL variant of the `Broadcaster`
 * implementation that turns an RDB into a polling-based pub/sub;
 * `src/realtime/mysql_database_broadcaster.ts`). Covers the same aspects as
 * `test/realtime/sqlite_database_broadcaster.test.ts` against a real MySQL
 * server (Docker), using the `broadcasts` table and `mysql_migrations` from
 * `test/test_support/fixtures/mysql_schema.ts` (migrations applied the same
 * way as `test/jobs/mysql_database_job_queue.test.ts`).
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is not set, all tests in
 * this file are skipped via `describe.skipIf` (same gate as
 * `test/jobs/mysql_database_job_queue.test.ts`).
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/realtime/mysql_database_broadcaster.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { BroadcastMessage } from "../../src/realtime/broadcaster.js";
import { MySqlDatabaseBroadcaster } from "../../src/realtime/mysql_database_broadcaster.js";
import * as schema from "../test_support/fixtures/mysql_schema.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;
const migrationsFolder = new URL("../test_support/fixtures/mysql_migrations", import.meta.url)
	.pathname;

/** Waits `ms` milliseconds of real time. A test-only helper to reliably span one polling cycle. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects, applies migrations, and clears `broadcasts` rows left over from
 * the previous test before returning. Other tables such as `jobs` or
 * `publishers` are not touched since this file does not use them.
 */
const createTestDb = async (url: string) => {
	const connection = await createConnection(url);
	const db = drizzle(connection, { schema, mode: "default" });
	await migrate(db, { migrationsFolder });
	await connection.query("DELETE FROM broadcasts");
	return { connection, db };
};

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlDatabaseBroadcaster", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb>>;

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		ctx = await createTestDb(OVEN_MYSQL_TEST_URL);
	});

	afterEach(async () => {
		await ctx.connection.end();
	});

	test("delivers published messages to subscribed listeners via polling", async () => {
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});

		await broadcaster.publish("room:1", { data: "before-subscribe" });

		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));

		await sleep(150);
		expect(received).toEqual([]);
	});

	test("delivers correctly to each of two subscribed channels and not to an unsubscribed channel", async () => {
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const unsubscribe = broadcaster.subscribe("room:1", () => {});

		unsubscribe();
		expect(() => unsubscribe()).not.toThrow();
	});

	test("delivery to other listeners on the same channel continues even if a listener throws", async () => {
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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

	test("does not fetch beyond pollLimit (cuts off at the limit and fetches the rest on the next poll)", async () => {
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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

	test("the same message is not delivered twice (verifies cursor advancement)", async () => {
		const broadcaster = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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

	test("publish from one instance reaches a subscriber on another instance via the same db/table", async () => {
		const publisher = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
			pollIntervalMs: 10,
		});
		const subscriber = new MySqlDatabaseBroadcaster(ctx.db, schema.broadcasts, {
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
