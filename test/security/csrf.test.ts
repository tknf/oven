/**
 * Verifies `Csrf` (token-based CSRF protection) (docs/testing.md L1). Checks
 * the masked token round trip (both header and form field paths), a 403 on
 * mismatch, passthrough for exception paths, and passthrough for safe
 * methods. Uses a real combination of `InMemorySessionStorage` +
 * `SessionAccessor` for the session, since CSRF is expected to run after the
 * session accessor.
 */
import type { Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { csrfMetaTag, Csrf } from "../../src/security/csrf.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";

type AppEnv = Env & { Variables: { session: Session } };

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

/** Builds a test app wired with session + CSRF. */
const buildApp = (exceptions?: { origin: string; path: string }[]) => {
	const storage = new InMemorySessionStorage();
	const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
	const csrf = new Csrf<AppEnv>({ session: sessionAccessor.use, exceptions });

	const app = new Hono<AppEnv>();
	app.use(sessionAccessor.register);
	app.use(csrf.verify);
	app.get("/form", (c) => c.text(csrf.csrfToken(c)));
	app.post("/action", (c) => c.text("done"));
	app.post("/callback", (c) => c.text("done"));

	return app;
};

/** Sends a GET to `/form` and returns the pair of the token string and the session Cookie header. */
const issueToken = async (app: Hono<AppEnv>): Promise<{ token: string; cookieHeader: string }> => {
	const res = await app.request("/form");
	const setCookie = res.headers.get("Set-Cookie");
	if (!setCookie) throw new Error("Set-Cookie was not issued");

	return { token: await res.text(), cookieHeader: toCookieHeader(setCookie) };
};

describe("Csrf", () => {
	test("GET passes through without token verification", async () => {
		const app = buildApp();

		const res = await app.request("/form");

		expect(res.status).toBe(200);
	});

	test("succeeds when the correct token is sent via the X-CSRF-Token header", async () => {
		const app = buildApp();
		const { token, cookieHeader } = await issueToken(app);

		const res = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookieHeader, "X-CSRF-Token": token },
		});

		expect(res.status).toBe(200);
	});

	test("succeeds when the correct token is sent via the form field (csrf_token)", async () => {
		const app = buildApp();
		const { token, cookieHeader } = await issueToken(app);

		const res = await app.request("/action", {
			method: "POST",
			headers: {
				Cookie: cookieHeader,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ csrf_token: token }).toString(),
		});

		expect(res.status).toBe(200);
	});

	test("a POST without a token results in 403", async () => {
		const app = buildApp();

		const res = await app.request("/action", { method: "POST" });

		expect(res.status).toBe(403);
	});

	test("a tampered token results in 403", async () => {
		const app = buildApp();
		const { token, cookieHeader } = await issueToken(app);
		/**
		 * Tamper with the first character (not the last). In Base64URL, the
		 * leftover bits of the trailing group can be fixed padding zero bits,
		 * so tampering with the last character can probabilistically fail to
		 * change the decoded result (confirmed to actually be flaky). The
		 * first character always carries the top 6 bits of the first 3-byte
		 * group, so tampering with it reliably affects the decoded result.
		 */
		const tampered = `${token[0] === "a" ? "b" : "a"}${token.slice(1)}`;

		const res = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookieHeader, "X-CSRF-Token": tampered },
		});

		expect(res.status).toBe(403);
	});

	test("a token issued in a different session (no Cookie) results in 403", async () => {
		const app = buildApp();
		const { token } = await issueToken(app);

		const res = await app.request("/action", {
			method: "POST",
			headers: { "X-CSRF-Token": token },
		});

		expect(res.status).toBe(403);
	});

	test("issues a different string each time csrfToken is called even for the same session (BREACH mitigation)", async () => {
		const app = buildApp();
		const first = await app.request("/form");
		const cookieHeader = toCookieHeader(first.headers.get("Set-Cookie") ?? "");
		const firstToken = await first.text();

		const second = await app.request("/form", { headers: { Cookie: cookieHeader } });
		const secondToken = await second.text();

		expect(firstToken).not.toBe(secondToken);
	});

	test("a cross-site POST matching the origin x path exception list passes through even without a token", async () => {
		const app = buildApp([{ origin: "https://provider.example", path: "/callback" }]);

		const res = await app.request("/callback", {
			method: "POST",
			headers: { Origin: "https://provider.example" },
		});

		expect(res.status).toBe(200);
	});

	test("results in 403 when origin matches but path differs, since it is not an exception", async () => {
		const app = buildApp([{ origin: "https://provider.example", path: "/callback" }]);

		const res = await app.request("/action", {
			method: "POST",
			headers: { Origin: "https://provider.example" },
		});

		expect(res.status).toBe(403);
	});
});

describe("csrfMetaTag", () => {
	test("returns the meta element string", () => {
		expect(csrfMetaTag("abc123")).toBe('<meta name="csrf-token" content="abc123">');
	});

	test("escapes even when the token contains special HTML characters", () => {
		const tag = csrfMetaTag('"><script>alert(1)</script>');

		expect(tag).not.toContain("<script>");
		expect(tag).toContain("&lt;script&gt;");
	});
});
