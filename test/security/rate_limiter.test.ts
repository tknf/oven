/**
 * Verifies `RateLimiter` (fixed-window rate limiting) on Node by injecting
 * `InMemoryKeyValueStore` (docs/testing.md L1). It previously depended on a
 * KV binding and could only run on workerd, but injecting `KeyValueStore`
 * made Node testing possible.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { KeyValueStore } from "../../src/kv/key_value_store.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { RateLimiter } from "../../src/security/rate_limiter.js";

type StoredEntry = {
	value: string;
	ttlSeconds: number | undefined;
};

class RecordingKeyValueStore extends KeyValueStore {
	private readonly entries = new Map<string, StoredEntry>();
	getCalls = 0;
	setCalls = 0;
	deleteCalls = 0;

	async get(key: string): Promise<string | null> {
		this.getCalls += 1;
		return this.entries.get(key)?.value ?? null;
	}

	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		this.setCalls += 1;
		this.entries.set(key, { value, ttlSeconds });
	}

	async delete(key: string): Promise<void> {
		this.deleteCalls += 1;
		this.entries.delete(key);
	}

	seed(key: string, value: string, ttlSeconds?: number): void {
		this.entries.set(key, { value, ttlSeconds });
	}

	peek(key: string): StoredEntry | undefined {
		return this.entries.get(key);
	}
}

describe("RateLimiter", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("consume returns true up to limit times and false once the limit is reached", async () => {
		const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
		const key = "ratelimit:test:consume";
		const limit = 3;

		for (let i = 0; i < limit; i++) {
			await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(true);
		}

		await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(false);
	});

	test("isLimited probes without consuming or writing an attempt", async () => {
		const store = new RecordingKeyValueStore();
		const rateLimiter = new RateLimiter(store);
		const key = "ratelimit:test:is-limited";

		await expect(rateLimiter.isLimited(key, 2, 60)).resolves.toBe(false);
		expect(store.getCalls).toBe(1);
		expect(store.setCalls).toBe(0);
		expect(store.deleteCalls).toBe(0);

		await expect(rateLimiter.consume(key, 2, 60)).resolves.toBe(true);
		const afterFirstConsume = store.peek(key);
		const setCallsAfterFirstConsume = store.setCalls;

		await expect(rateLimiter.isLimited(key, 2, 1)).resolves.toBe(false);
		await expect(rateLimiter.isLimited(key, 2, 3_600)).resolves.toBe(false);
		expect(store.peek(key)).toEqual(afterFirstConsume);
		expect(store.setCalls).toBe(setCallsAfterFirstConsume);
		expect(store.deleteCalls).toBe(0);

		await expect(rateLimiter.consume(key, 2, 60)).resolves.toBe(true);
		const atLimit = store.peek(key);
		await expect(rateLimiter.isLimited(key, 2, 1)).resolves.toBe(true);
		await expect(rateLimiter.isLimited(key, 2, 3_600)).resolves.toBe(true);
		expect(store.peek(key)).toEqual(atLimit);
		expect(store.setCalls).toBe(setCallsAfterFirstConsume + 1);
		expect(store.deleteCalls).toBe(0);
		await expect(rateLimiter.consume(key, 2, 60)).resolves.toBe(false);
	});

	test("the count increases with each consume", async () => {
		const store = new InMemoryKeyValueStore();
		const rateLimiter = new RateLimiter(store);
		const key = "ratelimit:test:count";

		await rateLimiter.consume(key, 5, 60);
		await rateLimiter.consume(key, 5, 60);

		const raw = await store.get(key);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toMatchObject({ count: 2 });
	});

	test("resets as a new window after windowSeconds elapses", async () => {
		const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
		const key = "ratelimit:test:window";
		const limit = 2;

		for (let i = 0; i < limit; i++) {
			await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(true);
		}
		await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(false);

		vi.advanceTimersByTime(60_000);

		await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(true);
	});

	test("counters are namespaced per key: exhausting one key does not affect another", async () => {
		const store = new InMemoryKeyValueStore();
		const rateLimiter = new RateLimiter(store);
		const limit = 2;

		for (let i = 0; i < limit; i++) {
			await expect(rateLimiter.consume("ratelimit:test:keyA", limit, 60)).resolves.toBe(true);
		}
		await expect(rateLimiter.consume("ratelimit:test:keyA", limit, 60)).resolves.toBe(false);

		await expect(rateLimiter.consume("ratelimit:test:keyB", limit, 60)).resolves.toBe(true);
	});

	// Documents intentional fail-open-on-corruption behavior: `parseState` returns `null` for
	// values that are not JSON or don't match the expected shape, and `consume` treats a `null`
	// state the same as no state at all, i.e. a fresh window. The store is app-owned, so this is
	// an accepted tradeoff rather than a bug — this test only asserts the current behavior and
	// that it does not throw.
	test("corrupted stored state is treated as a fresh window instead of throwing", async () => {
		const store = new InMemoryKeyValueStore();
		const rateLimiter = new RateLimiter(store);

		await store.set("ratelimit:test:not-json", "not json", 60);
		await expect(rateLimiter.consume("ratelimit:test:not-json", 3, 60)).resolves.toBe(true);

		await store.set("ratelimit:test:wrong-shape", JSON.stringify({ count: "x", resetAt: 1 }), 60);
		await expect(rateLimiter.consume("ratelimit:test:wrong-shape", 3, 60)).resolves.toBe(true);
	});

	test("isLimited treats expired and corrupted state as zero without repairing it", async () => {
		const store = new RecordingKeyValueStore();
		const rateLimiter = new RateLimiter(store);
		const nowSeconds = Math.floor(Date.now() / 1000);
		const expiredKey = "ratelimit:test:is-limited-expired";
		const corruptKey = "ratelimit:test:is-limited-corrupt";

		store.seed(expiredKey, JSON.stringify({ count: 99, resetAt: nowSeconds - 1 }), 17);
		store.seed(corruptKey, "not json", 23);
		const expiredBefore = store.peek(expiredKey);
		const corruptBefore = store.peek(corruptKey);

		await expect(rateLimiter.isLimited(expiredKey, 5, 60)).resolves.toBe(false);
		await expect(rateLimiter.isLimited(corruptKey, 5, 60)).resolves.toBe(false);

		expect(store.peek(expiredKey)).toEqual(expiredBefore);
		expect(store.peek(corruptKey)).toEqual(corruptBefore);
		expect(store.setCalls).toBe(0);
		expect(store.deleteCalls).toBe(0);
	});

	test("isLimited treats non-positive limits as limited without writing a fresh key", async () => {
		const store = new RecordingKeyValueStore();
		const rateLimiter = new RateLimiter(store);

		await expect(rateLimiter.isLimited("ratelimit:test:is-limited-zero", 0, 60)).resolves.toBe(
			true,
		);
		await expect(rateLimiter.isLimited("ratelimit:test:is-limited-negative", -1, 60)).resolves.toBe(
			true,
		);

		expect(store.getCalls).toBe(2);
		expect(store.setCalls).toBe(0);
		expect(store.deleteCalls).toBe(0);
	});

	test("isLimited uses an active resetAt regardless of probe windowSeconds", async () => {
		const store = new RecordingKeyValueStore();
		const rateLimiter = new RateLimiter(store);
		const key = "ratelimit:test:is-limited-reset-at";
		const resetAt = Math.floor(Date.now() / 1000) + 60;

		store.seed(key, JSON.stringify({ count: 1, resetAt }), 123);
		const before = store.peek(key);

		await expect(rateLimiter.isLimited(key, 2, 1)).resolves.toBe(false);
		await expect(rateLimiter.isLimited(key, 1, 3_600)).resolves.toBe(true);

		expect(store.peek(key)).toEqual(before);
		expect(store.setCalls).toBe(0);
		expect(store.deleteCalls).toBe(0);
	});

	test("consume with limit 0 returns false on the very first call", async () => {
		const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());

		await expect(rateLimiter.consume("ratelimit:test:zero-limit", 0, 60)).resolves.toBe(false);
	});

	test("reset() resets immediately and allows up to limit again", async () => {
		const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
		const key = "ratelimit:test:reset";
		const limit = 2;

		for (let i = 0; i < limit; i++) {
			await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(true);
		}
		await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(false);

		await rateLimiter.reset(key);

		await expect(rateLimiter.consume(key, limit, 60)).resolves.toBe(true);
	});
});
