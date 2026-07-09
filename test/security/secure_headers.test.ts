/**
 * Verifies `SecureHeaders` (a thin preset over `hono/secure-headers`). Checks
 * that X-Frame-Options is hardened to DENY by default and that an override
 * via `options` takes precedence.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { SecureHeaders } from "../../src/security/secure_headers.js";

describe("SecureHeaders", () => {
	test("sets key headers such as X-Frame-Options: DENY by default", async () => {
		const secureHeaders = new SecureHeaders();
		const app = new Hono();
		app.use(secureHeaders.register);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");

		expect(res.headers.get("X-Frame-Options")).toBe("DENY");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("an explicit xFrameOptions in options takes precedence", async () => {
		const secureHeaders = new SecureHeaders({ xFrameOptions: "SAMEORIGIN" });
		const app = new Hono();
		app.use(secureHeaders.register);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/");

		expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
	});
});
