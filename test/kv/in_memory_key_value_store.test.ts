/**
 * Verifies `InMemoryKeyValueStore` (a `KeyValueStore` implementation for
 * development and testing): set/get round-trips, TTL expiry, overwrite,
 * and delete (docs/testing.md L1).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";

describe("InMemoryKeyValueStore", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("a value set can be retrieved with get", async () => {
		const store = new InMemoryKeyValueStore();

		await store.set("key", "value");

		await expect(store.get("key")).resolves.toBe("value");
	});

	test("a nonexistent key returns null", async () => {
		const store = new InMemoryKeyValueStore();

		await expect(store.get("missing")).resolves.toBeNull();
	});

	test("get succeeds before ttlSeconds elapses", async () => {
		const store = new InMemoryKeyValueStore();

		await store.set("key", "value", 60);
		vi.advanceTimersByTime(59_000);

		await expect(store.get("key")).resolves.toBe("value");
	});

	test("after ttlSeconds elapses, returns null and removes the entry", async () => {
		const store = new InMemoryKeyValueStore();

		await store.set("key", "value", 60);
		vi.advanceTimersByTime(60_000);

		await expect(store.get("key")).resolves.toBeNull();
	});

	test("set on the same key overwrites the value", async () => {
		const store = new InMemoryKeyValueStore();

		await store.set("key", "first");
		await store.set("key", "second");

		await expect(store.get("key")).resolves.toBe("second");
	});

	test("a deleted key returns null from get", async () => {
		const store = new InMemoryKeyValueStore();

		await store.set("key", "value");
		await store.delete("key");

		await expect(store.get("key")).resolves.toBeNull();
	});
});
