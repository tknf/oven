/**
 * Verifies `UpstashRedisStore` (a `KeyValueStore` implementation that calls
 * the Upstash Redis REST API). Injects a dummy fetch and only inspects the
 * request shape (URL, Authorization header, SET with TTL, `set` putting the
 * value in the request body rather than the URL path) and response
 * interpretation (reading `{ result: ... }`, mapping a missing key to null).
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { UpstashRedisStore } from "../../src/kv/upstash_redis_store.js";

/** A dummy fetch that returns a `Response`, wrapped in `vi.fn` so call arguments can be verified. */
const buildFetch = (result: string | null, status = 200) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result }), { status }));

describe("UpstashRedisStore", () => {
	test("get requests the GET command path and returns the result", async () => {
		const fetch = buildFetch("value");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await expect(store.get("key")).resolves.toBe("value");

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://dummy.upstash.io/get/key");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer dummy-token");
	});

	test("get for a nonexistent key returns null", async () => {
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch: buildFetch(null),
		});

		await expect(store.get("missing")).resolves.toBeNull();
	});

	test("set with ttlSeconds includes EX as a query parameter and puts the value in the body", async () => {
		const fetch = buildFetch("OK");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await store.set("key", "value", 60);

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://dummy.upstash.io/set/key?EX=60");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe("value");
	});

	test("set without ttlSeconds omits EX and puts the value in the body", async () => {
		const fetch = buildFetch("OK");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await store.set("key", "value");

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://dummy.upstash.io/set/key");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe("value");
	});

	test("set never puts the value itself in the URL path (avoids leaking large or sensitive values)", async () => {
		const fetch = buildFetch("OK");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		const secretValue = "s3cr3t-token-value";
		await store.set("session:1", secretValue);

		const [url] = fetch.mock.calls[0];
		expect(url).not.toContain(secretValue);
	});

	test("delete requests the DEL command path", async () => {
		const fetch = buildFetch("1");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await store.delete("key");

		const [url] = fetch.mock.calls[0];
		expect(url).toBe("https://dummy.upstash.io/del/key");
	});

	test("the key is URL-encoded (the value doesn't need encoding since it goes in the body)", async () => {
		const fetch = buildFetch("OK");
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await store.set("a/b", "v v");

		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe("https://dummy.upstash.io/set/a%2Fb");
		expect(init?.body).toBe("v v");
	});

	test("when timeoutMs is set, an AbortSignal is passed to the fetch call", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response(JSON.stringify({ result: "value" }), { status: 200 });
		});
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
			timeoutMs: 5000,
		});

		await store.get("key");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("when timeoutMs is omitted, fetch is called without a signal as before", async () => {
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			expect(init?.signal).toBeUndefined();
			return new Response(JSON.stringify({ result: "value" }), { status: 200 });
		});
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await store.get("key");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("a non-2xx response throws including the response body", async () => {
		const fetch = vi.fn(async () => new Response("boom", { status: 500 }));
		const store = new UpstashRedisStore({
			url: "https://dummy.upstash.io",
			token: "dummy-token",
			fetch,
		});

		await expect(store.get("key")).rejects.toThrow(/boom/);
	});
});
