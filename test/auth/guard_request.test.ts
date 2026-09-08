/** Request authentication has no session dependency; the callback supplies verified subjects. */
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { Guard } from "../../src/auth/index.js";
import type { GuardOptions } from "../../src/auth/index.js";
import { Csrf } from "../../src/security/csrf.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";

type Account = { id: string; name: string };
type RequestEnv = { Variables: { account: Account } };
const createAccount = (id = "alice"): Account => ({ id, name: id.toUpperCase() });
const onFailure = (c: Context<RequestEnv>) => c.text("unauthorized", 401);
const createOptions = () =>
	({ authenticate: () => createAccount(), onFailure }) satisfies GuardOptions<
		RequestEnv,
		"account"
	>;

/** A controlled promise lets two real Hono requests overlap without timing assumptions. */
const createSignal = () => {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("Guard request authentication", () => {
	test.each([false, true])(
		"registers a verified subject without any session (async=%s)",
		async (asyncResult) => {
			const account = createAccount();
			let calls = 0;
			const guard = new Guard<RequestEnv, "account">("account", {
				authenticate: (c) => {
					calls++;
					expect(c.req.path).toBe("/protected");
					return asyncResult ? Promise.resolve(account) : account;
				},
				onFailure,
			});
			const app = new Hono<RequestEnv>();
			expect(guard.require).toBe(guard.register);
			const { register, use } = guard;
			app.get("/protected", register, (c) => {
				expect(use(c)).toBe(account);
				c.header("Cache-Control", "public, max-age=60");
				return c.text(use(c).name);
			});
			const response = await app.request("/protected", {
				headers: { Cookie: "session=irrelevant" },
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("ALICE");
			expect(response.headers.get("Set-Cookie")).toBeNull();
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(calls).toBe(1);
		},
	);

	test.each([null, undefined])(
		"nullish authentication calls onFailure without registering a subject (%s)",
		async (subject) => {
			let handled = false;
			const guard = new Guard<RequestEnv, "account">("account", {
				authenticate: async () => subject,
				onFailure: async (c) => {
					expect(c.get("account")).toBeUndefined();
					expect(() => guard.use(c)).toThrow('"account" has not been registered');
					return c.text("denied", 401);
				},
			});
			const app = new Hono<RequestEnv>();
			app.get("/", guard.require, (c) => {
				handled = true;
				return c.text("incorrect");
			});
			const response = await app.request("/");
			expect(response.status).toBe(401);
			expect(await response.text()).toBe("denied");
			expect(response.headers.get("Cache-Control")).toBeNull();
			expect(response.headers.get("Set-Cookie")).toBeNull();
			expect(handled).toBe(false);
		},
	);

	test.each([false, true])(
		"propagates verification errors instead of authenticating or calling onFailure (async=%s)",
		async (asyncError) => {
			const failure = new Error("verification service unavailable");
			let handled = false;
			let denied = false;
			const guard = new Guard<RequestEnv, "account">("account", {
				authenticate: () => {
					if (asyncError) return Promise.reject(failure);
					throw failure;
				},
				onFailure: (c) => {
					denied = true;
					return onFailure(c);
				},
			});
			const app = new Hono<RequestEnv>();
			app.onError((error, c) => {
				expect(error).toBe(failure);
				expect(c.get("account")).toBeUndefined();
				return c.text("unavailable", 503);
			});
			app.get("/", guard.require, (c) => {
				handled = true;
				return c.text("incorrect");
			});
			const response = await app.request("/");
			expect(response.status).toBe(503);
			expect(handled).toBe(false);
			expect(denied).toBe(false);
		},
	);

	test.each([false, 0, ""])("registers non-nullish falsy subjects (%s)", async (subject) => {
		type ScalarEnv = { Variables: { subject: string | number | boolean } };
		const guard = new Guard<ScalarEnv, "subject">("subject", {
			authenticate: () => subject,
			onFailure: (c) => c.text("unauthorized", 401),
		});
		const app = new Hono<ScalarEnv>();
		app.get("/", guard.require, (c) => {
			expect(guard.use(c)).toBe(subject);
			return c.text("accepted");
		});
		expect((await app.request("/")).status).toBe(200);
	});

	test("does not reuse a preceding request's successful or failed result", async () => {
		const subjects = [createAccount("alice"), null, createAccount("bob")];
		let calls = 0;
		const guard = new Guard<RequestEnv, "account">("account", {
			authenticate: () => subjects[calls++],
			onFailure,
		});
		const app = new Hono<RequestEnv>();
		app.get("/", guard.require, (c) => c.text(guard.use(c).id));
		expect(await (await app.request("/")).text()).toBe("alice");
		expect((await app.request("/")).status).toBe(401);
		expect(await (await app.request("/")).text()).toBe("bob");
		expect(calls).toBe(3);
	});

	test("keeps overlapping requests' subjects separate", async () => {
		const started = createSignal();
		const release = createSignal();
		let calls = 0;
		const guard = new Guard<RequestEnv, "account">("account", {
			authenticate: async (c) => {
				calls++;
				if (c.req.path === "/alice") {
					started.resolve();
					await release.promise;
				}
				return createAccount(c.req.path.slice(1));
			},
			onFailure,
		});
		const app = new Hono<RequestEnv>();
		app.get("/*", guard.require, (c) => c.text(guard.use(c).id));
		const alice = app.request("/alice");
		await started.promise;
		try {
			expect(await (await app.request("/bob")).text()).toBe("bob");
		} finally {
			release.resolve();
		}
		expect(await (await alice).text()).toBe("alice");
		expect(calls).toBe(2);
	});

	test("except matches only the complete request path and does not register or cache", async () => {
		let calls = 0;
		const guard = new Guard<RequestEnv, "account">("account", {
			authenticate: () => {
				calls++;
				return null;
			},
			onFailure,
			except: ["/public"],
		});
		const app = new Hono<RequestEnv>();
		app.use(guard.require);
		app.get("*", (c) => {
			expect(() => guard.use(c)).toThrow("account");
			return c.text("public");
		});
		const response = await app.request("/public?query=1");
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBeNull();
		expect(calls).toBe(0);
		for (const path of ["/public/", "/public/child", "/publicity"]) {
			expect((await app.request(path)).status).toBe(401);
		}
		expect(calls).toBe(3);
	});

	test("cacheControl false preserves the downstream cache policy", async () => {
		const guard = new Guard<RequestEnv, "account">("account", {
			...createOptions(),
			cacheControl: false,
		});
		const app = new Hono<RequestEnv>();
		app.get("/", guard.require, (c) => {
			c.header("Cache-Control", "private, max-age=0");
			return c.text("ok");
		});
		expect((await app.request("/")).headers.get("Cache-Control")).toBe("private, max-age=0");
	});

	test("use without registration still names the missing subject and middleware", async () => {
		const guard = new Guard<RequestEnv, "account">("account", createOptions());
		const app = new Hono<RequestEnv>();
		app.get("/", (c) => {
			expect(() => guard.use(c)).toThrow(
				'"account" has not been registered (Apply Guard\'s `require` middleware)',
			);
			return c.text("checked");
		});
		expect((await app.request("/")).status).toBe(200);
	});

	test("a separate session can protect CSRF without becoming an authentication source", async () => {
		type CsrfEnv = { Variables: { csrfSession: Session; account: Account } };
		const storage = new InMemorySessionStorage();
		const session = new SessionAccessor<CsrfEnv, "csrfSession">("csrfSession", storage);
		const csrf = new Csrf<CsrfEnv>({ session: session.use });
		let calls = 0;
		const guard = new Guard<RequestEnv, "account">("account", {
			authenticate: () => {
				calls++;
				return createAccount();
			},
			onFailure: (c) => c.text("unauthorized", 401),
		});
		const app = new Hono<CsrfEnv>();
		app.use(guard.require, session.register, csrf.verify);
		app.get("/form", (c) => c.text(csrf.csrfToken(c)));
		app.post("/action", (c) => {
			expect(session.use(c).get("accountId")).toBeUndefined();
			return c.text(guard.use(c).id);
		});
		const form = await app.request("/form");
		const token = await form.text();
		const cookie = form.headers.get("Set-Cookie")?.split(";")[0];
		if (!cookie) throw new Error("CSRF session cookie missing");
		expect(
			(await app.request("/action", { method: "POST", headers: { Cookie: cookie } })).status,
		).toBe(403);
		const accepted = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookie, "X-CSRF-Token": token },
		});
		expect(accepted.status).toBe(200);
		expect(await accepted.text()).toBe("alice");
		expect(calls).toBe(3);
	});
});

describe("Guard mode configuration", () => {
	const session = () => {
		throw new Error("must not read a session during configuration");
	};
	const provider = (id: string) => createAccount(id);
	const remember = { consume: async () => "alice" };

	test("rejects mixed and incomplete modes at compile time and construction time", () => {
		// @ts-expect-error Request authentication cannot include a session accessor.
		const withSession: GuardOptions<RequestEnv, "account"> = { ...createOptions(), session };
		// @ts-expect-error Request authentication cannot include an identity key.
		const withIdentity: GuardOptions<RequestEnv, "account"> = {
			...createOptions(),
			identityKey: "accountId",
		};
		// @ts-expect-error Request authentication cannot include a provider.
		const withProvider: GuardOptions<RequestEnv, "account"> = { ...createOptions(), provider };
		// @ts-expect-error Request authentication cannot include remember-me session restoration.
		const withRemember: GuardOptions<RequestEnv, "account"> = { ...createOptions(), remember };
		// @ts-expect-error An authentication mode is required.
		const missingMode: GuardOptions<RequestEnv, "account"> = { onFailure };
		// @ts-expect-error A session mode must include its provider.
		const partialSession: GuardOptions<RequestEnv, "account"> = {
			session,
			identityKey: "accountId",
			onFailure,
		};
		for (const options of [
			withSession,
			withIdentity,
			withProvider,
			withRemember,
			missingMode,
			partialSession,
		]) {
			expect(() => new Guard("account", options)).toThrow("Guard:");
		}
	});

	test("the callback subject must match the selected context variable", () => {
		const wrongSubject = { authenticate: () => ({ id: 123 }), onFailure };
		// @ts-expect-error The account subject must have string id and name fields.
		new Guard<RequestEnv, "account">("account", wrongSubject);
	});

	test.each([
		{ authenticate: undefined },
		{ authenticate: null },
		{ authenticate: "not callable" },
		{ ...createOptions(), session: undefined },
		{ ...createOptions(), identityKey: undefined },
		{ ...createOptions(), provider: undefined },
		{ ...createOptions(), remember: undefined },
		{ session: "not callable", identityKey: "accountId", provider },
		{ session, identityKey: 1, provider },
		{ session, identityKey: "accountId", provider: null },
		{ session, identityKey: "accountId", provider, authenticate: undefined },
		{ ...createOptions(), onFailure: undefined },
	])("rejects invalid untyped mode configuration %#", (options) => {
		expect(() => Reflect.construct(Guard, ["account", { onFailure, ...options }])).toThrow(
			"Guard:",
		);
	});
});
