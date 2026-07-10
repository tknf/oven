/**
 * Verifies `SessionAccessor` (an auto-committing accessor)
 * (docs/testing.md L1). Hits it directly on Node via `app.request()` and
 * checks that `Set-Cookie` is set only when dirty, that `use` throws when
 * unregistered, the factory form of storage, and data carrying over across
 * requests.
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import type { Session } from "../../src/session/session.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";

type AppEnv = Env & { Variables: { session: Session } };

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("SessionAccessor", () => {
	test("sets Set-Cookie when there is a dirty change", async () => {
		const storage = new InMemorySessionStorage();
		const accessor = new SessionAccessor<AppEnv, "session">("session", storage);

		const app = new Hono<AppEnv>();
		app.use(accessor.register);
		app.get("/", (c) => {
			accessor.use(c).set("userId", "u_1");
			return c.text("ok");
		});

		const res = await app.request("/");

		expect(res.headers.get("Set-Cookie")).not.toBeNull();
	});

	test("does not set Set-Cookie for a read-only (non-dirty) case", async () => {
		const storage = new InMemorySessionStorage();
		const commitSpy = vi.spyOn(storage, "commit");
		const accessor = new SessionAccessor<AppEnv, "session">("session", storage);

		const app = new Hono<AppEnv>();
		app.use(accessor.register);
		app.get("/", (c) => {
			accessor.use(c).get("userId");
			return c.text("ok");
		});

		const res = await app.request("/");

		expect(res.headers.get("Set-Cookie")).toBeNull();
		expect(commitSpy).not.toHaveBeenCalled();
	});

	test("throws with a message containing the key name when use is called without register applied", async () => {
		const storage = new InMemorySessionStorage();
		const accessor = new SessionAccessor<AppEnv, "session">("session", storage);

		const app = new Hono<AppEnv>();
		app.onError((err, c) => c.text(err.message, 500));
		app.get("/", (c) => c.text(accessor.use(c).get("userId") ? "yes" : "no"));

		const res = await app.request("/");

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("session");
	});

	test("can pass storage as a factory ((c) => storage)", async () => {
		const storage = new InMemorySessionStorage();
		const factory = vi.fn(() => storage);
		const accessor = new SessionAccessor<AppEnv, "session">("session", factory);

		const app = new Hono<AppEnv>();
		app.use(accessor.register);
		app.get("/", (c) => {
			accessor.use(c).set("userId", "u_1");
			return c.text("ok");
		});

		await app.request("/");

		expect(factory).toHaveBeenCalledTimes(1);
	});

	test("destroying a session that was also dirtied in the same request skips the automatic commit (destroy wins)", async () => {
		const storage = new InMemorySessionStorage();
		const commitSpy = vi.spyOn(storage, "commit");
		const accessor = new SessionAccessor<AppEnv, "session">("session", storage);

		const app = new Hono<AppEnv>();
		app.use(accessor.register);
		app.get("/", async (c) => {
			const session = accessor.use(c);
			session.flash("notice", "You have been logged out");
			const destroyCookie = await storage.destroy(session);
			c.header("Set-Cookie", destroyCookie, { append: true });
			return c.text("ok");
		});

		const res = await app.request("/");
		const setCookieHeaders = res.headers.getSetCookie();

		expect(commitSpy).not.toHaveBeenCalled();
		expect(setCookieHeaders).toHaveLength(1);
		expect(setCookieHeaders[0]).toContain("Max-Age=0");
	});

	test("data from a committed session carries over to the next request", async () => {
		const storage = new InMemorySessionStorage();
		const accessor = new SessionAccessor<AppEnv, "session">("session", storage);

		const app = new Hono<AppEnv>();
		app.use(accessor.register);
		app.get("/write", (c) => {
			accessor.use(c).set("userId", "u_1");
			return c.text("ok");
		});
		app.get("/read", (c) => c.text(String(accessor.use(c).get("userId"))));

		const writeRes = await app.request("/write");
		const setCookie = writeRes.headers.get("Set-Cookie");
		if (!setCookie) throw new Error("Set-Cookie was not set");

		const readRes = await app.request("/read", {
			headers: { Cookie: toCookieHeader(setCookie) },
		});

		expect(await readRes.text()).toBe("u_1");
	});
});
