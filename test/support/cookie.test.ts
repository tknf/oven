/**
 * Tests for `CookieAccessor`, the typed cookie accessor layer.
 * Uses `app.request()` to actually issue a response `Set-Cookie`, then hands it to the
 * next request's `Cookie` header to verify the round trip.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { CookieAccessor } from "../../src/support/cookie.js";

/** Extracts the `Cookie` header value to pass to the next request from the response's `Set-Cookie`. */
const extractCookieHeader = (res: Response): string => {
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) throw new Error("set-cookie was not issued");
	return setCookie.split(";")[0] ?? "";
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
