/**
 * Verifies `CloudflareCacheStore`, a `KeyValueStore` implementation backed by the Cache API,
 * in the workerd environment (docs/testing.md L3).
 */
import { describe, expect, test } from "vite-plus/test";
import { CloudflareCacheStore } from "../../src/cloudflare/cloudflare_cache_store.js";

/**
 * Because `tsconfig.json` has `lib: ["DOM", ...]`, the browser `CacheStorage` type
 * (`lib.dom.d.ts`, which has no `.default`) takes precedence in type resolution over the
 * Workers version from `@cloudflare/workers-types`, making `caches.default` a type error.
 * This test file is not included in the distributed package (not a `vp pack` entry), so this
 * declaration merge does not pollute consumers' types.
 */
declare global {
	interface CacheStorage {
		readonly default: Cache;
	}
}

describe("CloudflareCacheStore", () => {
	test("a value set can be retrieved with get, and becomes null after delete", async () => {
		const store = new CloudflareCacheStore({
			cache: caches.default,
			baseUrl: "https://oven-cache-store-test.internal/",
		});
		const key = "oven:cache:roundtrip";

		await store.set(key, "value");
		await expect(store.get(key)).resolves.toBe("value");

		await store.delete(key);
		await expect(store.get(key)).resolves.toBeNull();
	});

	test("a nonexistent key returns null", async () => {
		const store = new CloudflareCacheStore({
			cache: caches.default,
			baseUrl: "https://oven-cache-store-test.internal/",
		});
		expect(await store.get("oven:cache:does-not-exist")).toBeNull();
	});
});
