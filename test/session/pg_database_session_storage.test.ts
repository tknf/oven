/**
 * Verifies `PgDatabaseSessionStorage` (a session backed by an arbitrary
 * table injected on Drizzle pg-core) (docs/testing.md L1). Covers the same
 * aspects as `sqlite_database_session_storage.test.ts` (round trip, upsert,
 * expiration, destroy) using PGlite (an in-process WASM Postgres) and a
 * minimal schema defined inline in the test (not the app's `db/schema` or
 * `test/helpers/`).
 */
import { PGlite } from "@electric-sql/pglite";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { PgSessionRecordTable } from "../../src/session/pg_database_session_storage.js";
import { PgDatabaseSessionStorage } from "../../src/session/pg_database_session_storage.js";
import { Session } from "../../src/session/session.js";

/**
 * A minimal test-only schema holding only the id/data/expiresAt columns
 * required by `PgDatabaseSessionStorage`. `expiresAt` is epoch ms (requires
 * 64-bit precision), so `bigint(..., { mode: "number" })` is used (same
 * reason as `createdAt`/`updatedAt` in `test/model/pg_model.test.ts`).
 */
const sessionsTable = pgTable("sessions", {
	id: text("id").primaryKey(),
	data: text("data").notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
}) satisfies PgSessionRecordTable;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("PgDatabaseSessionStorage", () => {
	let client: PGlite;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at BIGINT NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(async () => {
		await client.close();
		vi.useRealTimers();
	});

	test("restores the same data when the committed Cookie is passed to get", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("returns an empty session when there is no corresponding row", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get("session=unknown-id");

		expect(session.get("userId")).toBeUndefined();
	});

	test("commit upserts the existing row with the same id (does not add a new row)", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		const restored = await storage.get(cookieHeader);
		restored.set("userId", "u_2");
		await storage.commit(restored);

		const rows = await client.query<{ count: number }>("SELECT COUNT(*) as count FROM sessions");
		expect(rows.rows[0]?.count).toBe(1);
		const afterUpdate = await storage.get(cookieHeader);
		expect(afterUpdate.get("userId")).toBe("u_2");
	});

	test("returns an empty session as expired when read after ttlSeconds has elapsed", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable, { ttlSeconds: 60 });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		vi.advanceTimersByTime(60_000 + 1);

		const restored = await storage.get(cookieHeader);
		expect(restored.get("userId")).toBeUndefined();
	});

	test("cannot be restored via get after destroy removes the row", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);
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
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});

	test("destroy marks the session as destroyed", async () => {
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");

		await storage.destroy(session);

		expect(session.isDestroyed).toBe(true);
	});
});
