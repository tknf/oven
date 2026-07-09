/**
 * Tests `freshWhen` (304 determination via conditional GET) and `CacheControl`
 * (Cache-Control presets).
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { CacheControl, freshWhen } from "../../src/cache/http_cache.js";

describe("freshWhen", () => {
	const buildApp = (options: Parameters<typeof freshWhen>[1]) => {
		const app = new Hono();
		app.on(["GET", "HEAD", "POST"], "/", (c) => {
			const notModified = freshWhen(c, options);
			if (notModified) return notModified;
			return c.text("fresh body");
		});
		return app;
	};

	test("returns 304 for an If-None-Match that matches the etag", async () => {
		const app = buildApp({ etag: "abc" });

		const res = await app.request("/", { headers: { "If-None-Match": '"abc"' } });

		expect(res.status).toBe(304);
	});

	test("an If-None-Match with the W/ prefix also matches via weak comparison", async () => {
		const app = buildApp({ etag: "abc" });

		const res = await app.request("/", { headers: { "If-None-Match": 'W/"abc"' } });

		expect(res.status).toBe(304);
	});

	test("always matches when If-None-Match is *", async () => {
		const app = buildApp({ etag: "abc" });

		const res = await app.request("/", { headers: { "If-None-Match": "*" } });

		expect(res.status).toBe(304);
	});

	test("behaves as null when the etag does not match (200 with the ETag header attached)", async () => {
		const app = buildApp({ etag: "abc" });

		const res = await app.request("/", { headers: { "If-None-Match": '"xyz"' } });

		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).toBe('W/"abc"');
		expect(await res.text()).toBe("fresh body");
	});

	test("If-None-Match takes priority over If-Modified-Since", async () => {
		const lastModifiedMs = Date.parse("2026-07-01T00:00:00.000Z");
		const app = buildApp({ etag: "abc", lastModifiedMs });

		const res = await app.request("/", {
			headers: {
				"If-None-Match": '"xyz"',
				"If-Modified-Since": new Date(lastModifiedMs).toUTCString(),
			},
		});

		expect(res.status).toBe(200);
	});

	test("returns 304 when If-Modified-Since, at second precision, is at or after lastModifiedMs", async () => {
		const lastModifiedMs = Date.parse("2026-07-01T00:00:00.500Z");
		const app = buildApp({ lastModifiedMs });

		const res = await app.request("/", {
			headers: { "If-Modified-Since": new Date("2026-07-01T00:00:00.000Z").toUTCString() },
		});

		expect(res.status).toBe(304);
	});

	test("returns 200 when If-Modified-Since is earlier than the last modification", async () => {
		const lastModifiedMs = Date.parse("2026-07-01T00:00:01.000Z");
		const app = buildApp({ lastModifiedMs });

		const res = await app.request("/", {
			headers: { "If-Modified-Since": new Date("2026-07-01T00:00:00.000Z").toUTCString() },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("Last-Modified")).toBe(new Date(lastModifiedMs).toUTCString());
	});

	test("is a no-op (no determination or header attachment) for unsafe methods like POST", async () => {
		const app = buildApp({ etag: "abc" });

		const res = await app.request("/", { method: "POST", headers: { "If-None-Match": '"abc"' } });

		expect(res.status).toBe(200);
		expect(res.headers.get("ETag")).toBeNull();
	});

	test("throws when both etag and lastModifiedMs are omitted", async () => {
		const app = new Hono();
		let caught: unknown;
		app.get("/", (c) => {
			try {
				freshWhen(c, {});
			} catch (error) {
				caught = error;
			}
			return c.text("ok");
		});

		await app.request("/");

		expect(caught).toBeInstanceOf(Error);
	});
});

describe("CacheControl", () => {
	test("directives are assembled into Cache-Control in the specified order", () => {
		const cacheControl = new CacheControl({
			directives: {
				public: true,
				maxAgeSeconds: 60,
				sMaxAgeSeconds: 120,
				staleWhileRevalidateSeconds: 30,
				staleIfErrorSeconds: 300,
				mustRevalidate: true,
				immutable: true,
			},
		});

		expect(cacheControl.value).toBe(
			"public, max-age=60, s-maxage=120, stale-while-revalidate=30, stale-if-error=300, must-revalidate, immutable",
		);
	});

	test("use attaches the value only when Cache-Control is not already set", async () => {
		const cacheControl = new CacheControl({ directives: { public: true, maxAgeSeconds: 60 } });
		const app = new Hono();
		app.use(cacheControl.use);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");

		expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
	});

	test("does not overwrite a Cache-Control explicitly set by the handler", async () => {
		const cacheControl = new CacheControl({ directives: { public: true, maxAgeSeconds: 60 } });
		const app = new Hono();
		app.use(cacheControl.use);
		app.get("/", (c) => {
			c.header("Cache-Control", "no-store");
			return c.text("ok");
		});

		const res = await app.request("/");

		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	test("CDN-Cache-Control is also attached when cdn is specified", async () => {
		const cacheControl = new CacheControl({
			directives: { public: true, maxAgeSeconds: 60 },
			cdn: { public: true, sMaxAgeSeconds: 3600 },
		});
		const app = new Hono();
		app.use(cacheControl.use);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");

		expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(res.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=3600");
	});

	test("throws when directives is effectively empty", () => {
		expect(() => new CacheControl({ directives: {} })).toThrow();
	});

	test("throws when public and private are specified together", () => {
		expect(() => new CacheControl({ directives: { public: true, private: true } })).toThrow();
	});

	test("throws when noStore is combined with other directives", () => {
		expect(() => new CacheControl({ directives: { noStore: true, maxAgeSeconds: 60 } })).toThrow();
	});

	test("specifying noStore alone is allowed", () => {
		const cacheControl = new CacheControl({ directives: { noStore: true } });

		expect(cacheControl.value).toBe("no-store");
	});

	test("throws when a seconds-based directive is negative", () => {
		expect(() => new CacheControl({ directives: { public: true, maxAgeSeconds: -1 } })).toThrow();
	});

	test("throws when a seconds-based directive is not an integer", () => {
		expect(() => new CacheControl({ directives: { public: true, maxAgeSeconds: 1.5 } })).toThrow();
	});
});
