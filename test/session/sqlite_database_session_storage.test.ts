/**
 * Verifies `SQLiteDatabaseSessionStorage` (a session backed by an arbitrary
 * table injected on Drizzle sqlite-core) (docs/testing.md L1). Checks the
 * round trip, expiration, and destroy using `@libsql/client`'s `:memory:`
 * and a minimal schema defined inline in the test (not the app's
 * `db/schema` or `test/helpers/`).
 */
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { SQLiteSessionRecordTable } from "../../src/session/sqlite_database_session_storage.js";
import { SQLiteDatabaseSessionStorage } from "../../src/session/sqlite_database_session_storage.js";
import { Session } from "../../src/session/session.js";

/** A minimal test-only schema holding only the id/data/expiresAt columns required by `SQLiteDatabaseSessionStorage`. */
const sessionsTable = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	data: text("data").notNull(),
	expiresAt: integer("expires_at").notNull(),
}) satisfies SQLiteSessionRecordTable;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("SQLiteDatabaseSessionStorage", () => {
	let client: Client;

	beforeEach(async () => {
		client = createClient({ url: ":memory:" });
		await client.execute(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(() => {
		client.close();
		vi.useRealTimers();
	});

	test("restores the same data when the committed Cookie is passed to get", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("returns an empty session when there is no corresponding row", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);

		const session = await storage.get("session=unknown-id");

		expect(session.get("userId")).toBeUndefined();
	});

	test("commit upserts the existing row with the same id (does not add a new row)", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		const restored = await storage.get(cookieHeader);
		restored.set("userId", "u_2");
		await storage.commit(restored);

		const rows = await client.execute("SELECT COUNT(*) as count FROM sessions");
		expect(rows.rows[0]?.count).toBe(1);
		const afterUpdate = await storage.get(cookieHeader);
		expect(afterUpdate.get("userId")).toBe("u_2");
	});

	test("returns an empty session as expired when read after ttlSeconds has elapsed", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable, { ttlSeconds: 60 });
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
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);
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
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});

	test("destroy marks the session as destroyed", async () => {
		const db = drizzle(client);
		const storage = new SQLiteDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");

		await storage.destroy(session);

		expect(session.isDestroyed).toBe(true);
	});
});
