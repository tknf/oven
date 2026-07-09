/**
 * Tests `DatabaseAccessor`. Drives it directly on Node via `app.request()` (no workerd
 * required). Focuses on how `scope` affects the number of `create` calls ("request" vs
 * "app", and memoization under concurrent requests).
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import { DatabaseAccessor } from "../../src/database/database_accessor.js";

type BaseEnv = Env & { Variables: { db?: string } };

describe("DatabaseAccessor", () => {
	test("use returns the value from create on a route where register is applied", async () => {
		const accessor = new DatabaseAccessor<BaseEnv, "db">("db", { create: () => "connection" });

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(await res.text()).toBe("connection");
	});

	test('scope "request" (default) calls create on every request', async () => {
		const create = vi.fn(() => "connection");
		const accessor = new DatabaseAccessor<BaseEnv, "db">("db", { create });

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await app.request("/");
		await app.request("/");

		expect(create).toHaveBeenCalledTimes(2);
	});

	test('scope "app" calls create only once across requests', async () => {
		const create = vi.fn(() => "connection");
		const accessor = new DatabaseAccessor<BaseEnv, "db">("db", { create, scope: "app" });

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await app.request("/");
		await app.request("/");

		expect(create).toHaveBeenCalledTimes(1);
	});

	test('scope "app" calls create only once even for concurrent requests', async () => {
		const create = vi.fn(async () => "connection");
		const accessor = new DatabaseAccessor<BaseEnv, "db">("db", { create, scope: "app" });

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await Promise.all([app.request("/"), app.request("/")]);

		expect(create).toHaveBeenCalledTimes(1);
	});

	test("calling use without register applied throws with a message that includes the key name", async () => {
		const accessor = new DatabaseAccessor<BaseEnv, "db">("db", { create: () => "connection" });

		const app = new Hono<BaseEnv>();
		app.onError((err, c) => c.text(err.message, 500));
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("db");
	});
});
