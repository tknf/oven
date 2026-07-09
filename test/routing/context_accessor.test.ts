/**
 * Tests for `ValueAccessor` (the simplest concrete class of `ContextAccessor`,
 * the abstract base for typed value wiring on the Hono context) and
 * `ScopedValueAccessor`, which adds memoization via `scope`. Hit directly on
 * Node via `app.request()` (no workerd required).
 */
import type { Context, Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import { ScopedValueAccessor, ValueAccessor } from "../../src/routing/context_accessor.js";

type BaseEnv = Env & { Variables: { greeting?: string } };

describe("ValueAccessor", () => {
	test("use returns the value from a synchronous create on a route with register applied", async () => {
		const accessor = new ValueAccessor<BaseEnv, "greeting">("greeting", () => "hello");

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(await res.text()).toBe("hello");
	});

	test("use returns the value from an asynchronous create on a route with register applied", async () => {
		const accessor = new ValueAccessor<BaseEnv, "greeting">("greeting", async () => "async-hello");

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(await res.text()).toBe("async-hello");
	});

	test("throws with a message containing the key name when use is called without register applied", async () => {
		const accessor = new ValueAccessor<BaseEnv, "greeting">("greeting", () => "hello");

		const app = new Hono<BaseEnv>();
		app.onError((err, c) => c.text(err.message, 500));
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("greeting");
	});

	test("create is called for each request", async () => {
		const create = vi.fn(() => "value");
		const accessor = new ValueAccessor<BaseEnv, "greeting">("greeting", create);

		const app = new Hono<BaseEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await app.request("/");
		await app.request("/");

		expect(create).toHaveBeenCalledTimes(2);
	});

	test("use can also be called from a Context of an extended Env (E2 extends E)", async () => {
		type AdminEnv = BaseEnv & { Variables: BaseEnv["Variables"] & { admin?: string } };

		const accessor = new ValueAccessor<BaseEnv, "greeting">("greeting", () => "hello-from-base");

		const app = new Hono<AdminEnv>();
		app.use(accessor.register);
		app.get("/", (c: Context<AdminEnv>) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(await res.text()).toBe("hello-from-base");
	});
});

type ScopedEnv = Env & { Variables: { value?: string } };

describe("ScopedValueAccessor", () => {
	test('create is called for each request when scope is unspecified (defaults to "request")', async () => {
		const create = vi.fn(() => "connection");
		const accessor = new ScopedValueAccessor<ScopedEnv, "value">("value", { create });

		const app = new Hono<ScopedEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await app.request("/");
		await app.request("/");

		expect(create).toHaveBeenCalledTimes(2);
	});

	test('scope "app" calls create only once across requests and returns the same value for every request', async () => {
		let counter = 0;
		const create = vi.fn(() => `connection-${++counter}`);
		const accessor = new ScopedValueAccessor<ScopedEnv, "value">("value", { create, scope: "app" });

		const app = new Hono<ScopedEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		const first = await app.request("/");
		const second = await app.request("/");

		expect(create).toHaveBeenCalledTimes(1);
		expect(await first.text()).toBe("connection-1");
		expect(await second.text()).toBe("connection-1");
	});

	test('scope "app" calls create only once even for concurrent requests', async () => {
		const create = vi.fn(async () => "connection");
		const accessor = new ScopedValueAccessor<ScopedEnv, "value">("value", { create, scope: "app" });

		const app = new Hono<ScopedEnv>();
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		await Promise.all([app.request("/"), app.request("/")]);

		expect(create).toHaveBeenCalledTimes(1);
	});

	test('scope "app" retries on the next resolve after create rejects once, and returns the value if it succeeds', async () => {
		let attempt = 0;
		const create = vi.fn(() => {
			attempt += 1;
			if (attempt === 1) throw new Error("fails on the first attempt");
			return "connection-2";
		});
		const accessor = new ScopedValueAccessor<ScopedEnv, "value">("value", { create, scope: "app" });

		const app = new Hono<ScopedEnv>();
		app.onError((err, c) => c.text(err.message, 500));
		app.use(accessor.register);
		app.get("/", (c) => c.text(accessor.use(c)));

		const first = await app.request("/");
		const second = await app.request("/");

		expect(first.status).toBe(500);
		expect(second.status).toBe(200);
		expect(await second.text()).toBe("connection-2");
		expect(create).toHaveBeenCalledTimes(2);
	});

	test("throws with a message containing a ScopedValueAccessor hint when use is called without register applied", async () => {
		const accessor = new ScopedValueAccessor<ScopedEnv, "value">("value", {
			create: () => "connection",
		});

		const app = new Hono<ScopedEnv>();
		app.onError((err, c) => c.text(err.message, 500));
		app.get("/", (c) => c.text(accessor.use(c)));

		const res = await app.request("/");

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("ScopedValueAccessor");
	});
});
