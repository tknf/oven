/**
 * Verifies `actingAs`, a helper that builds an authenticated session cookie header.
 * Confirms that a request carrying the `cookie` returned by `actingAs` passes authentication
 * on a route protected by `Guard` + `SessionAccessor` + `InMemorySessionStorage`.
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { Guard } from "../../src/auth/guard.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { actingAs } from "../../src/test/acting_as.js";

type Account = { id: string; name: string };
type AppEnv = Env & { Variables: { session: Session; account: Account } };

/** Builds a test app with `/protected` guarded by Guard, for verifying `actingAs`. */
const buildApp = (storage: InMemorySessionStorage) => {
	const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
	const accounts = new Map<string, Account>([["acc_1", { id: "acc_1", name: "Alice" }]]);

	const accountGuard = new Guard<AppEnv, "account">("account", {
		session: sessionAccessor.use,
		identityKey: "accountId",
		provider: (identity) => accounts.get(identity),
		onFailure: (c) => c.redirect("/login", 303),
	});

	const app = new Hono<AppEnv>();
	app.use(sessionAccessor.register);
	app.get("/protected", accountGuard.require, (c) => c.text(accountGuard.use(c).name));

	return app;
};

describe("actingAs", () => {
	test("attaching the cookie returned by actingAs passes a Guard-protected route", async () => {
		const storage = new InMemorySessionStorage();
		const app = buildApp(storage);

		const { cookie } = await actingAs(storage, { identityKey: "accountId", identity: "acc_1" });
		const res = await app.request("/protected", { headers: { Cookie: cookie } });

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("Alice");
	});

	test("without a cookie, falls through to onFailure (303 redirect)", async () => {
		const storage = new InMemorySessionStorage();
		const app = buildApp(storage);

		const res = await app.request("/protected");

		expect(res.status).toBe(303);
		expect(res.headers.get("Location")).toBe("/login");
	});
});
