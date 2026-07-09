/**
 * Tests `RememberToken` (the remember-me token) (docs/testing.md L1). Uses a real
 * `InMemoryKeyValueStore` to verify selector/validator-style token issuance, rotation,
 * tamper detection, expiration, forgetting, and behavior when there is no cookie.
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { RememberToken } from "../../src/auth/remember_token.js";

type AppEnv = Env;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

/** Builds a test app that calls `RememberToken#issue` at `/issue` and can be exercised via `/consume`/`/forget`. */
const buildApp = (rememberToken: RememberToken<AppEnv>) => {
	const app = new Hono<AppEnv>();
	app.get("/issue", async (c) => {
		await rememberToken.issue(c, "user_1");
		return c.text("issued");
	});
	app.get("/consume", async (c) => {
		const identity = await rememberToken.consume(c);
		return c.text(identity ?? "");
	});
	app.get("/forget", async (c) => {
		await rememberToken.forget(c);
		return c.text("forgotten");
	});
	return app;
};

/** GETs `/issue` and returns the issued cookie header. */
const issue = async (app: Hono<AppEnv>): Promise<string> => {
	const res = await app.request("/issue");
	const setCookie = res.headers.get("Set-Cookie");
	if (!setCookie) throw new Error("Set-Cookie was not issued");
	return toCookieHeader(setCookie);
};

describe("RememberToken", () => {
	test("issue attaches a Set-Cookie, and the plain-text validator is never stored", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const cookieHeader = await issue(app);
		const [, cookieValue] = cookieHeader.split("=");
		const [selector, validator] = cookieValue.split(".");

		const storedRaw = await store.get(`remember:${selector}`);
		expect(storedRaw).not.toBeNull();
		expect(storedRaw).not.toContain(validator);
	});

	test("consume after issue returns the identity and rotates the selector", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const cookieHeader = await issue(app);
		const [, oldCookieValue] = cookieHeader.split("=");
		const [oldSelector] = oldCookieValue.split(".");

		const res = await app.request("/consume", { headers: { Cookie: cookieHeader } });
		const newSetCookie = res.headers.get("Set-Cookie");
		if (!newSetCookie) throw new Error("Set-Cookie was not issued");
		const newCookieHeader = toCookieHeader(newSetCookie);
		const [, newCookieValue] = newCookieHeader.split("=");
		const [newSelector] = newCookieValue.split(".");

		expect(await res.text()).toBe("user_1");
		expect(newSelector).not.toBe(oldSelector);
		expect(await store.get(`remember:${oldSelector}`)).toBeNull();
		expect(await store.get(`remember:${newSelector}`)).not.toBeNull();
	});

	test("tampering with the validator returns null and also deletes the store entry", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const cookieHeader = await issue(app);
		const [name, cookieValue] = cookieHeader.split("=");
		const [selector, validator] = cookieValue.split(".");
		const tampered = `${validator[0] === "a" ? "b" : "a"}${validator.slice(1)}`;
		const tamperedCookieHeader = `${name}=${selector}.${tampered}`;

		const res = await app.request("/consume", { headers: { Cookie: tamperedCookieHeader } });

		expect(await res.text()).toBe("");
		expect(await store.get(`remember:${selector}`)).toBeNull();
	});

	test("a stored validatorHash that is not valid base64url returns null and also deletes the store entry", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const cookieHeader = await issue(app);
		const [name, cookieValue] = cookieHeader.split("=");
		const [selector] = cookieValue.split(".");
		await store.set(
			`remember:${selector}`,
			JSON.stringify({
				identity: "user_1",
				validatorHash: "!!!not-base64url!!!",
				expiresAt: Date.now() + 60_000,
			}),
		);

		const res = await app.request("/consume", { headers: { Cookie: cookieHeader } });
		const deleteCookie = res.headers.get("Set-Cookie") ?? "";

		expect(await res.text()).toBe("");
		expect(await store.get(`remember:${selector}`)).toBeNull();
		expect(deleteCookie).toContain("Max-Age=0");
		expect(deleteCookie.startsWith(`${name}=`)).toBe(true);
	});

	test("an expired token returns null", async () => {
		vi.useFakeTimers();
		try {
			const store = new InMemoryKeyValueStore();
			const rememberToken = new RememberToken<AppEnv>({ store, ttlSeconds: 60 });
			const app = buildApp(rememberToken);

			const cookieHeader = await issue(app);
			vi.advanceTimersByTime(61 * 1000);

			const res = await app.request("/consume", { headers: { Cookie: cookieHeader } });

			expect(await res.text()).toBe("");
		} finally {
			vi.useRealTimers();
		}
	});

	test("forget removes both the store entry and the cookie", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const cookieHeader = await issue(app);
		const [, cookieValue] = cookieHeader.split("=");
		const [selector] = cookieValue.split(".");

		const res = await app.request("/forget", { headers: { Cookie: cookieHeader } });
		const deleteCookie = res.headers.get("Set-Cookie") ?? "";

		expect(await store.get(`remember:${selector}`)).toBeNull();
		expect(deleteCookie).toContain("Max-Age=0");
	});

	test("consume without a cookie returns null", async () => {
		const store = new InMemoryKeyValueStore();
		const rememberToken = new RememberToken<AppEnv>({ store });
		const app = buildApp(rememberToken);

		const res = await app.request("/consume");

		expect(await res.text()).toBe("");
	});
});
