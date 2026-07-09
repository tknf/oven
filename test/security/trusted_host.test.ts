/**
 * Verifies `TrustedHost` (Host header validation middleware). Checks exact
 * match, subdomain wildcards, port stripping, a missing Host header, and
 * throwing on an empty array in the constructor.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { TrustedHost } from "../../src/security/trusted_host.js";

const buildApp = (hosts: string[]) => {
	const trustedHost = new TrustedHost(hosts);
	const app = new Hono();
	app.use(trustedHost.verify);
	app.get("/", (c) => c.text("ok"));
	return app;
};

describe("TrustedHost", () => {
	test("an exactly matching Host passes through", async () => {
		const app = buildApp(["example.com"]);

		const res = await app.request("/", { headers: { Host: "example.com" } });

		expect(res.status).toBe(200);
	});

	test("a non-matching Host is rejected with 400", async () => {
		const app = buildApp(["example.com"]);

		const res = await app.request("/", { headers: { Host: "evil.com" } });

		expect(res.status).toBe(400);
	});

	test("a leading-dot pattern matches both itself and its subdomains", async () => {
		const app = buildApp([".example.com"]);

		const bare = await app.request("/", { headers: { Host: "example.com" } });
		const sub = await app.request("/", { headers: { Host: "api.example.com" } });
		const other = await app.request("/", { headers: { Host: "notexample.com" } });

		expect(bare.status).toBe(200);
		expect(sub.status).toBe(200);
		expect(other.status).toBe(400);
	});

	test("a Host header with a port is matched after stripping the port", async () => {
		const app = buildApp(["example.com"]);

		const res = await app.request("/", { headers: { Host: "example.com:8787" } });

		expect(res.status).toBe(200);
	});

	test("an IPv6 literal in brackets is matched with and without a port", async () => {
		const app = buildApp(["[::1]"]);

		const withPort = await app.request("/", { headers: { Host: "[::1]:8787" } });
		const withoutPort = await app.request("/", { headers: { Host: "[::1]" } });
		const otherAddress = await app.request("/", { headers: { Host: "[::2]:8787" } });

		expect(withPort.status).toBe(200);
		expect(withoutPort.status).toBe(200);
		expect(otherAddress.status).toBe(400);
	});

	test("a joined multi-value Host header is rejected outright, not matched piecewise", async () => {
		const app = buildApp(["example.com"]);

		const res = await app.request("/", { headers: { Host: "example.com, evil.com" } });

		expect(res.status).toBe(400);
	});

	test("a leading-dot pattern does not match an unrelated domain that merely shares a suffix", async () => {
		const app = buildApp([".example.com"]);

		const res = await app.request("/", { headers: { Host: "evilexample.com" } });

		expect(res.status).toBe(400);
	});

	test("the comparison is case-insensitive", async () => {
		const app = buildApp(["Example.com"]);

		const res = await app.request("/", { headers: { Host: "EXAMPLE.COM" } });

		expect(res.status).toBe(200);
	});

	test("is rejected with 400 when there is no Host header (fail-closed)", async () => {
		const trustedHost = new TrustedHost(["example.com"]);
		const app = new Hono();
		app.use(trustedHost.verify);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/", { headers: {} });

		expect(res.status).toBe(400);
	});

	test("throws in the constructor for an empty array", () => {
		expect(() => new TrustedHost([])).toThrow();
	});
});
