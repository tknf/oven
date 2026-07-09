/**
 * Verifies `cacheFragment`, a helper that stores a rendered JSX fragment in the Cache and skips
 * re-rendering on a cache hit. Since JSX literals cannot be used, the tree is built with
 * `hono/jsx`'s `jsx()` function (same approach as `snippet.test.ts`).
 */
import { raw } from "hono/html";
import { jsx } from "hono/jsx";
import { describe, expect, test, vi } from "vite-plus/test";
import { Cache } from "../../src/cache/cache.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { cacheFragment } from "../../src/view/fragment_cache.js";

describe("cacheFragment", () => {
	test("the first call invokes render and returns HTML", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		const render = vi.fn(() => raw(jsx("div", { id: "item" }, "hello").toString()));

		const result = await cacheFragment(cache, "fragment:1", { ttlSeconds: 60 }, render);

		expect(render).toHaveBeenCalledTimes(1);
		expect(result.toString()).toBe('<div id="item">hello</div>');
	});

	test("a second call with the same key skips render and returns the same HTML from cache", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		const render = vi.fn(() => raw(jsx("div", { id: "item" }, "hello").toString()));

		const first = await cacheFragment(cache, "fragment:1", { ttlSeconds: 60 }, render);
		const second = await cacheFragment(cache, "fragment:1", { ttlSeconds: 60 }, render);

		expect(render).toHaveBeenCalledTimes(1);
		expect(second.toString()).toBe(first.toString());
	});

	test("changing the key triggers re-rendering", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		let call = 0;
		const render = vi.fn(() => raw(jsx("div", {}, `body${++call}`).toString()));

		const first = await cacheFragment(cache, "fragment:1", { ttlSeconds: 60 }, render);
		const second = await cacheFragment(cache, "fragment:2", { ttlSeconds: 60 }, render);

		expect(render).toHaveBeenCalledTimes(2);
		expect(first.toString()).toBe("<div>body1</div>");
		expect(second.toString()).toBe("<div>body2</div>");
	});

	test("embedding the return value in a layout does not double-escape", async () => {
		const cache = new Cache(new InMemoryKeyValueStore());
		const render = vi.fn(() => raw(jsx("div", {}, "a<b").toString()));

		const fragment = await cacheFragment(cache, "fragment:raw", { ttlSeconds: 60 }, render);
		const layout = jsx("section", {}, fragment);

		expect(layout.toString()).toBe("<section><div>a&lt;b</div></section>");
	});

	test("JSX containing dynamic values is cached in escaped form", async () => {
		const store = new InMemoryKeyValueStore();
		const cache = new Cache(store);
		const userInput = '<script>alert("xss")</script>';

		await cacheFragment(cache, "fragment:user", { ttlSeconds: 60 }, () =>
			raw(jsx("div", {}, userInput).toString()),
		);

		await expect(store.get("cache:fragment:user")).resolves.toBe(
			JSON.stringify("<div>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>"),
		);
	});
});
