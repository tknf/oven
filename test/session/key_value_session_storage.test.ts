/**
 * Verifies `KeyValueSessionStorage` (a sliding-TTL session backed by an
 * injected `KeyValueStore`) (docs/testing.md L1). Injects
 * `InMemoryKeyValueStore` and checks the sliding TTL's threshold behavior
 * (no re-put within the threshold, re-put once it is exceeded, and
 * swallowing a put failure).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { KeyValueSessionStorage } from "../../src/session/key_value_session_storage.js";
import { Session } from "../../src/session/session.js";

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("KeyValueSessionStorage", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("restores the same data when the committed Cookie is passed to get", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("returns an empty session when the store has no corresponding data", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());

		const session = await storage.get("session=unknown-id");

		expect(session.get("userId")).toBeUndefined();
	});

	test("ttlSeconds is passed to KeyValueStore.set as-is in relative seconds (no rounding up to 60 seconds)", async () => {
		const store = new InMemoryKeyValueStore();
		const setSpy = vi.spyOn(store, "set");
		const storage = new KeyValueSessionStorage(store, { ttlSeconds: 30 });
		const session = new Session("");
		session.set("userId", "u_1");

		await storage.commit(session);

		expect(setSpy).toHaveBeenCalledWith(expect.any(String), expect.any(String), 30);
	});

	test("commit stores the record under the default oven_session: key prefix", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const id = toCookieHeader(setCookie).split("=")[1];

		expect(await store.get(`oven_session:${id}`)).not.toBeNull();
	});

	test("a custom keyPrefix is used for commit, get, and destroy", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store, { keyPrefix: "admin_session:" });
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);
		const id = cookieHeader.split("=")[1];

		expect(await store.get(`admin_session:${id}`)).not.toBeNull();
		expect(await store.get(`oven_session:${id}`)).toBeNull();

		const restored = await storage.get(cookieHeader);
		expect(restored.get("userId")).toBe("u_1");

		await storage.destroy(restored);
		expect(await store.get(`admin_session:${id}`)).toBeNull();
	});

	test("a re-get within the threshold does not put to extend the TTL", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store, { refreshThresholdMs: 1000 * 60 * 60 });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		const setSpy = vi.spyOn(store, "set");
		vi.advanceTimersByTime(1000 * 60 * 30); // half of the threshold (1 hour)

		await storage.get(cookieHeader);

		expect(setSpy).not.toHaveBeenCalled();
	});

	test("a re-get beyond the threshold re-puts to extend the TTL", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store, { refreshThresholdMs: 1000 * 60 * 60 });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);

		const setSpy = vi.spyOn(store, "set");
		vi.advanceTimersByTime(1000 * 60 * 60 + 1);

		const restored = await storage.get(cookieHeader);

		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(restored.get("userId")).toBe("u_1");
	});

	test("get still returns the data normally even if the TTL-extending put fails", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store, { refreshThresholdMs: 0 });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);
		vi.advanceTimersByTime(1);

		vi.spyOn(store, "set").mockRejectedValueOnce(new Error("put failed"));

		const restored = await storage.get(cookieHeader);

		expect(restored.get("userId")).toBe("u_1");
	});

	test("cannot be restored via get after destroy removes it from the store", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store);
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const cookieHeader = toCookieHeader(setCookie);
		const restored = await storage.get(cookieHeader);

		await storage.destroy(restored);

		const afterDestroy = await storage.get(cookieHeader);
		expect(afterDestroy.get("userId")).toBeUndefined();
	});

	test("get returns an empty session when the stored record is not valid JSON", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store);
		await store.set("oven_session:corrupted-id", "not json", 60);

		const session = await storage.get("session=corrupted-id");

		expect(session.get("userId")).toBeUndefined();
		expect(session.data).toEqual({});
	});

	test("get returns an empty session when the stored record has the wrong shape (isStoredRecord rejects it)", async () => {
		const store = new InMemoryKeyValueStore();
		const storage = new KeyValueSessionStorage(store);
		await store.set(
			"oven_session:wrong-shape-id",
			JSON.stringify({ data: [1], refreshedAt: 1 }),
			60,
		);

		const session = await storage.get("session=wrong-shape-id");

		expect(session.get("userId")).toBeUndefined();
		expect(session.data).toEqual({});
	});

	test("destroy returns a deletion Cookie value with Max-Age=0", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});

	test("destroy marks the session as destroyed", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());
		const session = new Session("");

		await storage.destroy(session);

		expect(session.isDestroyed).toBe(true);
	});

	test("commit after regenerate reissues the session ID, carries over the data, and empties the old ID's session", async () => {
		const storage = new KeyValueSessionStorage(new InMemoryKeyValueStore());
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
