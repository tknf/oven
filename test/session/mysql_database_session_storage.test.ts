/**
 * Verifies `MySqlDatabaseSessionStorage` (a session backed by an arbitrary
 * table injected on Drizzle mysql-core) (docs/testing.md L1). Covers the
 * same aspects as `sqlite_database_session_storage.test.ts` and
 * `pg_database_session_storage.test.ts` (round trip, upsert, expiration,
 * destroy) against a real MySQL server (Docker).
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is not set, all tests in
 * this file are skipped via `describe.skipIf` (same gate as
 * `test/model/mysql_model.test.ts`).
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/session/mysql_database_session_storage.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection } from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { MySqlSessionRecordTable } from "../../src/session/mysql_database_session_storage.js";
import { MySqlDatabaseSessionStorage } from "../../src/session/mysql_database_session_storage.js";
import { Session } from "../../src/session/session.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;

/**
 * A minimal test-only schema holding only the id/data/expiresAt columns
 * required by `MySqlDatabaseSessionStorage`. `expiresAt` is epoch ms
 * (requires 64-bit precision), so `bigint(..., { mode: "number" })` is used
 * (same reason as `createdAt`/`updatedAt` in `test/model/mysql_model.test.ts`).
 */
const sessionsTable = mysqlTable("sessions", {
	id: varchar("id", { length: 255 }).primaryKey(),
	data: varchar("data", { length: 4096 }).notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}) satisfies MySqlSessionRecordTable;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlDatabaseSessionStorage", () => {
	let connection: Connection;

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		connection = await createConnection(OVEN_MYSQL_TEST_URL);
		await connection.query("DROP TABLE IF EXISTS sessions");
		await connection.query(
			"CREATE TABLE sessions (id VARCHAR(255) PRIMARY KEY, data VARCHAR(4096) NOT NULL, expires_at BIGINT NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(async () => {
		await connection.end();
		vi.useRealTimers();
	});

	test("restores the same data when the committed Cookie is passed to get", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("returns an empty session when there is no corresponding row", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get("session=unknown-id");

		expect(session.get("userId")).toBeUndefined();
	});

	test("commit upserts the existing row with the same id (does not add a new row)", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		const restored = await storage.get(cookieHeader);
		restored.set("userId", "u_2");
		await storage.commit(restored);

		const [rows] = await connection.query("SELECT COUNT(*) as count FROM sessions");
		const [row] = rows as Array<{ count: number }>;
		expect(row?.count).toBe(1);
		const afterUpdate = await storage.get(cookieHeader);
		expect(afterUpdate.get("userId")).toBe("u_2");
	});

	test("returns an empty session as expired when read after ttlSeconds has elapsed", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable, { ttlSeconds: 60 });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		vi.advanceTimersByTime(60_000 + 1);

		const restored = await storage.get(cookieHeader);
		expect(restored.get("userId")).toBeUndefined();
	});

	test("cannot be restored via get after destroy removes the row", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);
		const restored = await storage.get(cookieHeader);

		await storage.destroy(restored);

		const afterDestroy = await storage.get(cookieHeader);
		expect(afterDestroy.get("userId")).toBeUndefined();
	});

	test("destroy returns a deletion Cookie value with Max-Age=0", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});
});
