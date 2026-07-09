/**
 * Verifies `parsePaginationQuery` (extracting and validating
 * `?cursor=...&limit=...`). To confirm behavior when reading values from an
 * actual query string, this drives real requests through `new Hono()` +
 * `app.request`.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { decodeCursor, encodeCursor } from "../../src/pagination/cursor_codec.js";
import { parsePaginationQuery } from "../../src/pagination/pagination_query.js";

const buildApp = (options: Parameters<typeof parsePaginationQuery>[1]) => {
	const app = new Hono();
	app.get("/items", (c) => c.json(parsePaginationQuery(c, options)));
	return app;
};

describe("parsePaginationQuery", () => {
	test("a valid limit value is used as given", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?limit=30");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 30 });
	});

	test("defaultLimit is used when limit is missing", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("defaultLimit is used when limit is not a number", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?limit=abc");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("defaultLimit is used when limit is 0 or below", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const zero = await app.request("/items?limit=0");
		const negative = await app.request("/items?limit=-5");
		expect(await zero.json()).toEqual({ cursor: undefined, limit: 20 });
		expect(await negative.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("limit is clamped when it exceeds maxLimit", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?limit=1000000");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 100 });
	});

	test("a fractional limit is truncated", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?limit=15.9");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 15 });
	});

	test("defaultLimit is used when limit is a fraction between 0 and 1 (truncates to 0)", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?limit=0.5");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("cursor is undefined when missing", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("with decodeCursor supplied, the decoded value is returned", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100, decodeCursor });
		const res = await app.request(`/items?cursor=${encodeCursor(42)}`);
		expect(await res.json()).toEqual({ cursor: 42, limit: 20 });
	});

	test("becomes undefined when decodeCursor fails to decode (returns null)", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100, decodeCursor });
		const res = await app.request("/items?cursor=!!!not-base64!!!");
		expect(await res.json()).toEqual({ cursor: undefined, limit: 20 });
	});

	test("without decodeCursor, the raw string is returned as-is", async () => {
		const app = buildApp({ defaultLimit: 20, maxLimit: 100 });
		const res = await app.request("/items?cursor=raw-cursor-value");
		expect(await res.json()).toEqual({ cursor: "raw-cursor-value", limit: 20 });
	});

	test("custom parameter names can be specified", async () => {
		const app = buildApp({
			defaultLimit: 20,
			maxLimit: 100,
			cursorParam: "after",
			limitParam: "per_page",
		});
		const res = await app.request("/items?after=xyz&per_page=5");
		expect(await res.json()).toEqual({ cursor: "xyz", limit: 5 });
	});
});
