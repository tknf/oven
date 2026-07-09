/**
 * Tests `Cache` (a thin caching layer over an injected `KeyValueStore`) using an
 * injected `InMemoryKeyValueStore`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Cache } from "../../src/cache/cache.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";

describe("Cache", () => {
	test("an object stored with put can be retrieved with get", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		const value = { name: "oven", version: 1 };

		await cache.put("object", value);

		await expect(cache.get("object")).resolves.toEqual(value);
	});

	test("a number stored with put can be retrieved with get", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());

		await cache.put("number", 42);

		await expect(cache.get("number")).resolves.toBe(42);
	});

	test("a string stored with put can be retrieved with get", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());

		await cache.put("string", "hello");

		await expect(cache.get("string")).resolves.toBe("hello");
	});

	test("get returns null for a nonexistent key", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());

		await expect(cache.get("missing")).resolves.toBeNull();
	});

	test("remember runs compute and stores the result on a miss", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		const compute = vi.fn(async () => "computed");

		const result = await cache.remember("key", 60, compute);

		expect(result).toBe("computed");
		expect(compute).toHaveBeenCalledTimes(1);
		await expect(cache.get("key")).resolves.toBe("computed");
	});

	test("remember does not call compute on a hit", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		await cache.put("key", "cached");
		const compute = vi.fn(async () => "computed");

		const result = await cache.remember("key", 60, compute);

		expect(result).toBe("cached");
		expect(compute).not.toHaveBeenCalled();
	});

	test("when compute returns null, it does not throw, returns null, and does not store it", async () => {
		const store = new InMemoryKeyValueStore();
		const cache = new Cache(store);
		const compute = vi.fn(async () => null);

		const result = await cache.remember("key", 60, compute);

		expect(result).toBeNull();
		expect(compute).toHaveBeenCalledTimes(1);
		await expect(store.get("cache:key")).resolves.toBeNull();
	});

	test("when compute returns undefined, it does not throw, returns undefined, and does not store it", async () => {
		const store = new InMemoryKeyValueStore();
		const cache = new Cache(store);
		const compute = vi.fn(async () => undefined);

		const result = await cache.remember("key", 60, compute);

		expect(result).toBeUndefined();
		expect(compute).toHaveBeenCalledTimes(1);
		await expect(store.get("cache:key")).resolves.toBeNull();
	});

	test("get returns null after forget", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		await cache.put("key", "value");

		await cache.forget("key");

		await expect(cache.get("key")).resolves.toBeNull();
	});

	test("prefix is reflected in the store key", async () => {
		const store = new InMemoryKeyValueStore();
		const cache = new Cache(store, { prefix: "myapp:" });

		await cache.put("key", "value");

		await expect(store.get("myapp:key")).resolves.toBe(JSON.stringify("value"));
		await expect(store.get("cache:key")).resolves.toBeNull();
	});

	test("the default prefix is cache:", async () => {
		const store = new InMemoryKeyValueStore();
		const cache = new Cache(store);

		await cache.put("key", "value");

		await expect(store.get("cache:key")).resolves.toBe(JSON.stringify("value"));
	});

	test("put throws for undefined", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());

		await expect(cache.put("key", undefined)).rejects.toThrow(/not JSON-serializable/);
	});

	describe("remember + SWR (stale-while-revalidate)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		test("throws when options is specified but ttlSeconds is omitted", async () => {
			const cache = new Cache(new InMemoryKeyValueStore());
			const compute = vi.fn(async () => "computed");

			await expect(
				cache.remember("key", undefined, compute, { staleWhileRevalidateSeconds: 30 }),
			).rejects.toThrow(/ttlSeconds/);
		});

		test("with options specified, a miss stores an envelope and compute is not called during the fresh period", async () => {
			const cache = new Cache(new InMemoryKeyValueStore());
			const compute = vi.fn(async () => "computed");

			const result = await cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });
			expect(result).toBe("computed");
			expect(compute).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(59_000);
			const hit = await cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });
			expect(hit).toBe("computed");
			expect(compute).toHaveBeenCalledTimes(1);
		});

		test("recomputes inline during the stale period, returning and storing the new value", async () => {
			const store = new InMemoryKeyValueStore();
			const cache = new Cache(store);
			let call = 0;
			const compute = vi.fn(async () => `computed-${++call}`);

			const first = await cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });
			expect(first).toBe("computed-1");

			vi.advanceTimersByTime(60_000 + 1);
			const staleResult = await cache.remember("key", 60, compute, {
				staleWhileRevalidateSeconds: 30,
			});
			expect(staleResult).toBe("computed-2");
			expect(compute).toHaveBeenCalledTimes(2);

			const hit = await cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });
			expect(hit).toBe("computed-2");
			expect(compute).toHaveBeenCalledTimes(2);
		});

		test("during the stale period, a soft claim extends freshUntil", async () => {
			const store = new InMemoryKeyValueStore();
			const cache = new Cache(store);
			let resolveCompute: ((value: string) => void) | undefined;
			const compute = vi.fn(
				() =>
					new Promise<string>((resolve) => {
						resolveCompute = resolve;
					}),
			);

			await cache.remember("key", 60, async () => "initial", { staleWhileRevalidateSeconds: 30 });

			vi.advanceTimersByTime(60_000 + 1);

			const pending = cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });

			// The soft claim (a put that only extends freshUntil while keeping the stale
			// value) commits without waiting for `compute` to resolve. Drain a few
			// microtasks to wait for that completion (`compute` itself does not resolve
			// until resolveCompute is called, so it is unaffected by this drain).
			for (let i = 0; i < 10; i++) await Promise.resolve();

			const raw = await store.get("cache:key");
			expect(raw).not.toBeNull();
			const envelope = JSON.parse(raw ?? "{}") as { value: string; freshUntil: number };
			expect(envelope.value).toBe("initial");
			expect(envelope.freshUntil).toBe(Date.now() + 30_000);

			resolveCompute?.("revalidated");
			await expect(pending).resolves.toBe("revalidated");
		});

		test("when waitUntil is specified, the stale value is returned immediately and recomputed/put in the background", async () => {
			const store = new InMemoryKeyValueStore();
			const cache = new Cache(store);
			await cache.remember("key", 60, async () => "initial", { staleWhileRevalidateSeconds: 30 });

			vi.advanceTimersByTime(60_000 + 1);

			const backgroundTasks: Promise<void>[] = [];
			const waitUntil = (promise: Promise<void>) => {
				backgroundTasks.push(promise);
			};
			const compute = vi.fn(async () => "revalidated");

			const result = await cache.remember("key", 60, compute, {
				staleWhileRevalidateSeconds: 30,
				waitUntil,
			});
			expect(result).toBe("initial");

			await Promise.all(backgroundTasks);
			expect(compute).toHaveBeenCalledTimes(1);

			const raw = await store.get("cache:key");
			const envelope = JSON.parse(raw ?? "{}") as { value: string; freshUntil: number };
			expect(envelope.value).toBe("revalidated");
		});

		test("a raw JSON entry (not envelope-shaped) is treated as a miss and overwritten", async () => {
			const store = new InMemoryKeyValueStore();
			const cache = new Cache(store);
			await cache.put("key", "legacy-plain-value");

			const compute = vi.fn(async () => "computed");
			const result = await cache.remember("key", 60, compute, { staleWhileRevalidateSeconds: 30 });

			expect(result).toBe("computed");
			expect(compute).toHaveBeenCalledTimes(1);

			const raw = await store.get("cache:key");
			const envelope = JSON.parse(raw ?? "{}") as { value: string; freshUntil: number };
			expect(envelope.value).toBe("computed");
		});

		test("returns the stale value when compute returns null/undefined during the stale period (fail-soft)", async () => {
			const cache = new Cache(new InMemoryKeyValueStore());
			await cache.remember("key", 60, async () => "initial", { staleWhileRevalidateSeconds: 30 });

			vi.advanceTimersByTime(60_000 + 1);

			const result = await cache.remember("key", 60, async () => undefined, {
				staleWhileRevalidateSeconds: 30,
			});
			expect(result).toBe("initial");
		});

		test("legacy behavior without options is unchanged (still stored as raw JSON)", async () => {
			const store = new InMemoryKeyValueStore();
			const cache = new Cache(store);
			const compute = vi.fn(async () => "computed");

			const result = await cache.remember("key", 60, compute);

			expect(result).toBe("computed");
			await expect(store.get("cache:key")).resolves.toBe(JSON.stringify("computed"));
		});
	});
});
