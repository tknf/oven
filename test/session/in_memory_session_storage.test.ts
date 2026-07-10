/**
 * Verifies `InMemorySessionStorage` (a `SessionStorage` implementation for
 * development and testing) (docs/testing.md L1).
 */
import { describe, expect, test } from "vite-plus/test";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { Session } from "../../src/session/session.js";

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("InMemorySessionStorage", () => {
	test("restores the same data when the committed Cookie is passed to get", async () => {
		const storage = new InMemorySessionStorage();
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const storage = new InMemorySessionStorage();

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("returns an empty session for an unknown session id", async () => {
		const storage = new InMemorySessionStorage();

		const session = await storage.get("session=unknown-id");

		expect(session.get("userId")).toBeUndefined();
	});

	test("commit does not issue a new ID every time (it updates the same session)", async () => {
		const storage = new InMemorySessionStorage();
		const session = new Session("");
		session.set("userId", "u_1");
		const firstCookie = await storage.commit(session);

		const restored = await storage.get(toCookieHeader(firstCookie));
		restored.set("userId", "u_2");
		const secondCookie = await storage.commit(restored);

		expect(toCookieHeader(firstCookie)).toBe(toCookieHeader(secondCookie));
	});

	test("cannot be restored via get after destroy discards the session", async () => {
		const storage = new InMemorySessionStorage();
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		await storage.destroy(restored);

		const afterDestroy = await storage.get(toCookieHeader(setCookie));
		expect(afterDestroy.get("userId")).toBeUndefined();
	});

	test("destroy returns a deletion Cookie value with Max-Age=0", async () => {
		const storage = new InMemorySessionStorage();

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});

	test("destroy marks the session as destroyed", async () => {
		const storage = new InMemorySessionStorage();
		const session = new Session("");

		await storage.destroy(session);

		expect(session.isDestroyed).toBe(true);
	});

	test("commit after regenerate reissues the session ID, carries over the data, and empties the old ID's session", async () => {
		const storage = new InMemorySessionStorage();
		const session = new Session("");
		session.set("userId", "u_1");
		const firstCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(firstCookie));

		restored.regenerate();
		const secondCookie = await storage.commit(restored);

		expect(toCookieHeader(secondCookie)).not.toBe(toCookieHeader(firstCookie));

		const viaOldId = await storage.get(toCookieHeader(firstCookie));
		expect(viaOldId.get("userId")).toBeUndefined();

		const viaNewId = await storage.get(toCookieHeader(secondCookie));
		expect(viaNewId.get("userId")).toBe("u_1");
	});
});
