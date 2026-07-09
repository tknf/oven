/**
 * Verifies `RateLimiter` (fixed-window rate limiting) on Node by injecting
 * `InMemoryKeyValueStore` (docs/testing.md L1). It previously depended on a
 * KV binding and could only run on workerd, but injecting `KeyValueStore`
 * made Node testing possible.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { RateLimiter } from "../../src/security/rate_limiter.js";

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
