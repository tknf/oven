/**
 * Tests for `healthCheck` (the conventional health check handler).
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { healthCheck } from "../../src/routing/health_check.js";
import { RouteHandler } from "../../src/routing/route_handler.js";

describe("healthCheck", () => {
	test("returns 200, ok, and no-store when wired on a plain Hono via app.get('/up', healthCheck)", async () => {
		const app = new Hono();
		app.get("/up", healthCheck);

		const res = await app.request("/up");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	test("can also be wired via a RouteHandler subclass", async () => {
		class SystemHandler extends RouteHandler {
			protected register() {
				this.get("/up", healthCheck);
			}
		}

		const app = new Hono();
		app.route("/", new SystemHandler());

		const res = await app.request("/up");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});
});
