/**
 * Tests `Guard` (authentication guard) (docs/testing.md L1).
 * Combines a real `InMemorySessionStorage` + `SessionAccessor` and verifies: missing
 * identifier, delegation to `onFailure` on provider failure, `use` on success, `use`
 * throwing on a route without the middleware applied, the identity-provider pattern,
 * the default `Cache-Control: no-store` behavior and disabling it, `require` operating
 * as the same instance as `register`, `remember` (remember-me token) integration, and
 * the `except` exact-match path exclusion.
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { Guard } from "../../src/auth/guard.js";
import { RememberToken } from "../../src/auth/remember_token.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";

type Account = { id: string; name: string };
type AppEnv = Env & { Variables: { session: Session; account: Account } };

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

/** Builds a test app that sets an identity at `/login` and protects `/protected` with a Guard from then on. */
const buildApp = (options?: { cacheControl?: boolean }) => {
	const storage = new InMemorySessionStorage();
	const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);

	const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

	const accountGuard = new Guard<AppEnv, "account">("account", {
		session: sessionAccessor.use,
		identityKey: "accountId",
		provider: (identity) => accounts.get(identity),
		onFailure: (c) => c.redirect("/login", 303),
		cacheControl: options?.cacheControl,
	});

	const app = new Hono<AppEnv>();
	app.use(sessionAccessor.register);
	app.post("/login", (c) => {
		const id = c.req.query("id") ?? "acc_1";
		sessionAccessor.use(c).set("accountId", id);
		return c.text("logged in");
	});
	app.get("/protected", accountGuard.require, (c) => c.text(accountGuard.use(c).name));

	return app;
};

/** POSTs to `/login` and returns the issued session cookie header. Defaults to `acc_1` if `id` is not specified. */
const login = async (app: Hono<AppEnv>, id?: string): Promise<string> => {
	const res = await app.request(`/login${id ? `?id=${id}` : ""}`, { method: "POST" });
	const setCookie = res.headers.get("Set-Cookie");
	if (!setCookie) throw new Error("Set-Cookie was not issued");
	return toCookieHeader(setCookie);
};

describe("Guard", () => {
	test("responds with onFailure's response when the session has no identifier", async () => {
		const app = buildApp();

		const res = await app.request("/protected");

		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/login");
	});

	test("responds with onFailure's response when provider returns undefined (unknown identifier)", async () => {
		const app = buildApp();
		const cookieHeader = await login(app, "acc_unknown");

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(res.status).toBe(303);
	});

	test("the resolved subject can be retrieved via use on successful authentication", async () => {
		const app = buildApp();
		const cookieHeader = await login(app);

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Alice");
	});

	test("calling use on a route where require is not applied throws with a message that includes the key name", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => ({ id: identity, name: identity }),
			onFailure: (c) => c.redirect("/login", 303),
		});

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		app.onError((err, c) => c.text(err.message, 500));
		app.get("/unprotected", (c) => c.text(accountGuard.use(c).name));

		const res = await app.request("/unprotected");

		expect(res.status).toBe(500);
		expect(await res.text()).toContain("account");
	});

	test("passing an identity function as provider treats the identifier itself as the subject (a Guard that skips the DB)", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<
			Env & { Variables: { session: Session; accountId: string } },
			"session"
		>("session", storage);
		const accountIdGuard = new Guard<
			Env & { Variables: { session: Session; accountId: string } },
			"accountId"
		>("accountId", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => identity,
			onFailure: (c) => c.redirect("/login", 303),
		});

		const app = new Hono<Env & { Variables: { session: Session; accountId: string } }>();
		app.use(sessionAccessor.register);
		app.post("/login", (c) => {
			sessionAccessor.use(c).set("accountId", "acc_1");
			return c.text("logged in");
		});
		app.get("/protected", accountIdGuard.require, (c) => c.text(accountIdGuard.use(c)));

		const loginRes = await app.request("/login", { method: "POST" });
		const setCookie = loginRes.headers.get("Set-Cookie");
		if (!setCookie) throw new Error("Set-Cookie was not issued");
		const cookieHeader = toCookieHeader(setCookie);

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(await res.text()).toBe("acc_1");
	});

	test("Cache-Control: no-store is attached by default on successful authentication", async () => {
		const app = buildApp();
		const cookieHeader = await login(app);

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(res.headers.get("Cache-Control")).toBe("no-store");
	});

	test("passing cacheControl: false does not attach Cache-Control", async () => {
		const app = buildApp({ cacheControl: false });
		const cookieHeader = await login(app);

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(res.headers.get("Cache-Control")).toBeNull();
	});

	test("onFailure can return an arbitrary response shape, such as a 401 JSON body (equivalent to the former requireListener)", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: () => undefined,
			onFailure: (c) => c.json({ error: "unauthorized" }, 401),
		});

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		app.get("/api/protected", accountGuard.require, (c) => c.text("ok"));

		const res = await app.request("/api/protected");

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	test("require operates as the same instance as register", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => ({ id: identity, name: identity }),
			onFailure: (c) => c.redirect("/login", 303),
		});

		expect(accountGuard.require).toBe(accountGuard.register);

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		app.post("/login", (c) => {
			sessionAccessor.use(c).set("accountId", "acc_1");
			return c.text("logged in");
		});
		app.get("/protected", accountGuard.register, (c) => c.text(accountGuard.use(c).name));

		const loginRes = await app.request("/login", { method: "POST" });
		const setCookie = loginRes.headers.get("Set-Cookie");
		if (!setCookie) throw new Error("Set-Cookie was not issued");

		const res = await app.request("/protected", {
			headers: { Cookie: toCookieHeader(setCookie) },
		});

		expect(await res.text()).toBe("acc_1");
	});

	test("remember: passes through on a successful consume even without session authentication, and sets identityKey into the session", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => accounts.get(identity),
			onFailure: (c) => c.redirect("/login", 303),
			remember: rememberToken,
		});

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		app.get("/issue-remember", async (c) => {
			await rememberToken.issue(c, "acc_1");
			return c.text("issued");
		});
		app.get("/protected", accountGuard.require, (c) => {
			const session = sessionAccessor.use(c);
			return c.text(`${accountGuard.use(c).name}:${String(session.get("accountId"))}`);
		});

		const issueRes = await app.request("/issue-remember");
		const setCookie = issueRes.headers.get("Set-Cookie");
		if (!setCookie) throw new Error("Set-Cookie was not issued");
		const cookieHeader = toCookieHeader(setCookie);

		const res = await app.request("/protected", { headers: { Cookie: cookieHeader } });

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Alice:acc_1");
	});

	test("remember: falls back to onFailure as before when consume fails", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });

		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => ({ id: identity, name: identity }),
			onFailure: (c) => c.redirect("/login", 303),
			remember: rememberToken,
		});

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		app.get("/protected", accountGuard.require, (c) => c.text(accountGuard.use(c).name));

		const res = await app.request("/protected");

		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/login");
	});

	test("remember: authenticating via a consumed remember token rotates the session ID (session fixation defense)", async () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

		const accountGuard = new Guard<AppEnv, "account">("account", {
			session: sessionAccessor.use,
			identityKey: "accountId",
			provider: (identity) => accounts.get(identity),
			onFailure: (c) => c.redirect("/login", 303),
			remember: rememberToken,
		});

		const app = new Hono<AppEnv>();
		app.use(sessionAccessor.register);
		// Simulates the pre-authentication session a session-fixation attacker would
		// know: a visit that dirties (and thus commits) the session before login.
		app.post("/touch", (c) => {
			sessionAccessor.use(c).set("touched", "1");
			return c.text("touched");
		});
		app.get("/issue-remember", async (c) => {
			await rememberToken.issue(c, "acc_1");
			return c.text("issued");
		});
		app.get("/protected", accountGuard.require, (c) => c.text(accountGuard.use(c).name));

		const touchRes = await app.request("/touch", { method: "POST" });
		const preAuthSetCookie = touchRes.headers.get("Set-Cookie");
		if (!preAuthSetCookie) throw new Error("Set-Cookie was not issued");
		const preAuthSessionCookie = toCookieHeader(preAuthSetCookie);

		const issueRes = await app.request("/issue-remember");
		const rememberSetCookie = issueRes.headers.get("Set-Cookie");
		if (!rememberSetCookie) throw new Error("Set-Cookie was not issued");
		const rememberCookie = toCookieHeader(rememberSetCookie);

		const res = await app.request("/protected", {
			headers: { Cookie: `${preAuthSessionCookie}; ${rememberCookie}` },
		});
		const postAuthSetCookie = res.headers.get("Set-Cookie");
		if (!postAuthSetCookie) throw new Error("Set-Cookie was not issued on authentication");
		const postAuthSessionCookie = toCookieHeader(postAuthSetCookie);

		expect(res.status).toBe(200);
		expect(postAuthSessionCookie).not.toBe(preAuthSessionCookie);
	});

	test("behavior is unchanged from before when remember is not specified", async () => {
		const app = buildApp();

		const res = await app.request("/protected");

		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/login");
	});

	describe("except", () => {
		/** Builds a test app that protects `/admin/*` with a single Guard except `/admin/login`. */
		const buildAppWithExcept = () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
			const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

			const accountGuard = new Guard<AppEnv, "account">("account", {
				session: sessionAccessor.use,
				identityKey: "accountId",
				provider: (identity) => accounts.get(identity),
				onFailure: (c) => c.redirect("/admin/login", 303),
				except: ["/admin/login"],
			});

			const app = new Hono<AppEnv>();
			app.use(sessionAccessor.register);
			app.post("/login", (c) => {
				const id = c.req.query("id") ?? "acc_1";
				sessionAccessor.use(c).set("accountId", id);
				return c.text("logged in");
			});
			app.use("/admin/*", accountGuard.require);
			app.get("/admin/login", (c) => c.text("login page"));
			app.get("/admin/login/sub", (c) => c.text("sub page"));
			app.get("/admin", (c) => c.text("admin root"));
			app.get("/admin/dashboard", (c) => c.text(accountGuard.use(c).name));

			return { app, accountGuard };
		};

		test("a path that exactly matches except passes through without authentication", async () => {
			const { app } = buildAppWithExcept();

			const res = await app.request("/admin/login");

			expect(res.status).toBe(200);
			expect(await res.text()).toBe("login page");
		});

		test("an excepted path does not attach Cache-Control: no-store", async () => {
			const { app } = buildAppWithExcept();

			const res = await app.request("/admin/login");

			expect(res.headers.get("Cache-Control")).toBeNull();
		});

		test("a path not listed in except remains protected", async () => {
			const { app } = buildAppWithExcept();

			const res = await app.request("/admin/dashboard");

			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/admin/login");
		});

		test("except only matches exactly: a sub-path or a prefix of the excepted path stays protected", async () => {
			const { app } = buildAppWithExcept();

			const subRes = await app.request("/admin/login/sub");
			const rootRes = await app.request("/admin");

			expect(subRes.status).toBe(303);
			expect(rootRes.status).toBe(303);
		});

		test("an authenticated user hitting an excepted path also passes through without subject resolution", async () => {
			const { app } = buildAppWithExcept();
			const cookieHeader = await login(app);

			const res = await app.request("/admin/login", { headers: { Cookie: cookieHeader } });

			expect(res.status).toBe(200);
			expect(await res.text()).toBe("login page");
		});
	});
});
