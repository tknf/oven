/**
 * Tests for `CookieAccessor`/`SignedCookieAccessor`, the typed cookie accessor layer.
 * Uses `app.request()` to actually issue a response `Set-Cookie`, then hands it to the
 * next request's `Cookie` header to verify the round trip.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { CookieAccessor, SignedCookieAccessor } from "../../src/support/cookie.js";

/** Extracts the `Cookie` header value to pass to the next request from the response's `Set-Cookie`. */
const extractCookieHeader = (res: Response): string => {
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) throw new Error("set-cookie was not issued");
	return setCookie.split(";")[0] ?? "";
};

/**
 * Rewrites only the "value" part of a signed cookie (`name=<encodeURIComponent-encoded "value.signature">`),
 * leaving the signature intact (for tamper-detection tests). Blindly truncating the raw string would
 * break a percent-encoding sequence mid-way, causing `hono/cookie`'s signature-length check itself to
 * short-circuit into `undefined` (skipped without verification) instead of the intended `false`
 * (verified but mismatched), so this decodes, alters only the value part, and re-encodes.
 */
const tamperSignedCookieValue = (cookieHeader: string): string => {
	const separatorIndex = cookieHeader.indexOf("=");
	const name = cookieHeader.slice(0, separatorIndex);
	const decoded = decodeURIComponent(cookieHeader.slice(separatorIndex + 1));
	const signatureStart = decoded.lastIndexOf(".");
	const tampered = `${decoded.slice(0, signatureStart)}tampered${decoded.slice(signatureStart)}`;

	return `${name}=${encodeURIComponent(tampered)}`;
};

describe("CookieAccessor", () => {
	test("set followed by get reads back the written value as-is", async () => {
		const preference = new CookieAccessor({ name: "preference", options: { path: "/" } });

		const app = new Hono();
		app.get("/set", (c) => {
			preference.set(c, "dark-mode");
			return c.text("ok");
		});
		app.get("/get", (c) => c.text(preference.get(c) ?? "(none)"));

		const setRes = await app.request("/set");
		const cookie = extractCookieHeader(setRes);

		const getRes = await app.request("/get", { headers: { Cookie: cookie } });

		expect(await getRes.text()).toBe("dark-mode");
	});

	test("get returns `undefined` when the cookie is not set", async () => {
		const preference = new CookieAccessor({ name: "preference" });

		const app = new Hono();
		app.get("/", (c) => c.text(preference.get(c) ?? "(none)"));

		const res = await app.request("/");

		expect(await res.text()).toBe("(none)");
	});

	test("delete returns the pre-deletion value and issues Set-Cookie with Max-Age=0", async () => {
		const preference = new CookieAccessor({ name: "preference", options: { path: "/" } });

		const app = new Hono();
		app.get("/set", (c) => {
			preference.set(c, "dark-mode");
			return c.text("ok");
		});
		app.get("/delete", (c) => c.text(preference.delete(c) ?? "(none)"));

		const setRes = await app.request("/set");
		const cookie = extractCookieHeader(setRes);

		const deleteRes = await app.request("/delete", { headers: { Cookie: cookie } });

		expect(await deleteRes.text()).toBe("dark-mode");
		expect(deleteRes.headers.get("set-cookie")).toContain("Max-Age=0");
	});
});

describe("SignedCookieAccessor", () => {
	test("set followed by get reads back the signed value with verification", async () => {
		const session = new SignedCookieAccessor({
			name: "session",
			secret: "test-secret",
			options: { path: "/" },
		});

		const app = new Hono();
		app.get("/set", async (c) => {
			await session.set(c, "user-42");
			return c.text("ok");
		});
		app.get("/get", async (c) => c.text(String(await session.get(c))));

		const setRes = await app.request("/set");
		const cookie = extractCookieHeader(setRes);

		const getRes = await app.request("/get", { headers: { Cookie: cookie } });

		expect(await getRes.text()).toBe("user-42");
	});

	test("get returns `undefined` when the cookie is not set", async () => {
		const session = new SignedCookieAccessor({ name: "session", secret: "test-secret" });

		const app = new Hono();
		app.get("/", async (c) => c.text(String(await session.get(c))));

		const res = await app.request("/");

		expect(await res.text()).toBe("undefined");
	});

	test("get returns `false` for a tampered cookie value", async () => {
		const session = new SignedCookieAccessor({
			name: "session",
			secret: "test-secret",
			options: { path: "/" },
		});

		const app = new Hono();
		app.get("/set", async (c) => {
			await session.set(c, "user-42");
			return c.text("ok");
		});
		app.get("/get", async (c) => c.text(String(await session.get(c))));

		const setRes = await app.request("/set");
		const cookie = extractCookieHeader(setRes);
		const tampered = tamperSignedCookieValue(cookie);

		const getRes = await app.request("/get", { headers: { Cookie: tampered } });

		expect(await getRes.text()).toBe("false");
	});

	test("get returns `false` when verified with a different secret", async () => {
		const writer = new SignedCookieAccessor({
			name: "session",
			secret: "secret-a",
			options: { path: "/" },
		});
		const reader = new SignedCookieAccessor({ name: "session", secret: "secret-b" });

		const app = new Hono();
		app.get("/set", async (c) => {
			await writer.set(c, "user-42");
			return c.text("ok");
		});
		app.get("/get", async (c) => c.text(String(await reader.get(c))));

		const setRes = await app.request("/set");
		const cookie = extractCookieHeader(setRes);

		const getRes = await app.request("/get", { headers: { Cookie: cookie } });

		expect(await getRes.text()).toBe("false");
	});
});
