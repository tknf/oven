/**
 * Verifies `Csrf` (token-based CSRF protection) (docs/testing.md L1). Checks
 * the masked token round trip (both header and form field paths), a 403 on
 * mismatch, passthrough for exception paths, and passthrough for safe
 * methods. Uses a real combination of `InMemorySessionStorage` +
 * `SessionAccessor` for the session, since CSRF is expected to run after the
 * session accessor.
 */
import type { Env, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { csrfMetaTag, Csrf, type CsrfOptions } from "../../src/security/csrf.js";
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
const buildApp = (
	options: Omit<CsrfOptions<AppEnv>, "session"> = {},
	beforeCsrf?: MiddlewareHandler<AppEnv>,
) => {
	const storage = new InMemorySessionStorage();
	const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
	const csrf = new Csrf<AppEnv>({ session: sessionAccessor.use, ...options });

	const app = new Hono<AppEnv>();
	app.use(sessionAccessor.register);
	if (beforeCsrf) app.use(beforeCsrf);
	app.use(csrf.verify);
	app.get("/form", (c) => c.text(csrf.csrfToken(c)));
	app.post("/action", (c) => c.text("done"));
	app.post("/callback", (c) => c.text("done"));
	app.post("/body", async (c) => c.text(await c.req.text()));
	app.post("/fields", async (c) => {
		const body = await c.req.parseBody({ all: true });
		const file = body.file;
		return c.json({ tags: body.tags, file: file instanceof File ? await file.text() : null });
	});

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

	test.each([65_536, 65_537])("enforces the default form limit at %i bytes", async (size) => {
		const app = buildApp();
		const { token, cookieHeader } = await issueToken(app);
		const prefix = new URLSearchParams({ csrf_token: token, padding: "" }).toString();
		const body = prefix + "x".repeat(size - prefix.length);
		const res = await app.request("/body", {
			method: "POST",
			headers: { Cookie: cookieHeader, "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		expect(res.status).toBe(size === 65_536 ? 200 : 403);
		if (size === 65_536) expect(await res.text()).toBe(body);
	});

	test.each(["first", "last"])(
		"rejects oversized multipart bodies with the token %s",
		async (position) => {
			const app = buildApp();
			const { token, cookieHeader } = await issueToken(app);
			const body = new FormData();
			if (position === "first") body.append("csrf_token", token);
			body.append("file", new File(["x".repeat(65_536)], "large.txt"));
			if (position === "last") body.append("csrf_token", token);
			const res = await app.request("/action", {
				method: "POST",
				headers: { Cookie: cookieHeader },
				body,
			});
			expect(res.status).toBe(403);
			expect(await res.text()).toBe("Invalid CSRF token");
		},
	);

	test("preserves multipart files and repeated fields for downstream parsing", async () => {
		const app = buildApp();
		const { token, cookieHeader } = await issueToken(app);
		const body = new FormData();
		body.append("csrf_token", token);
		body.append("tags", "one");
		body.append("tags", "two");
		body.append("file", new File(["file contents"], "small.txt"));
		const res = await app.request("/fields", {
			method: "POST",
			headers: { Cookie: cookieHeader },
			body,
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ tags: ["one", "two"], file: "file contents" });
	});

	test.each(["text", "formData"] as const)(
		"supports bodies cached upstream through %s",
		async (method) => {
			const app = buildApp({}, async (c, next) => {
				if (c.req.method === "POST") await c.req[method]();
				await next();
			});
			const { token, cookieHeader } = await issueToken(app);
			const res = await app.request("/fields", {
				method: "POST",
				headers: { Cookie: cookieHeader },
				body: new URLSearchParams([
					["csrf_token", token],
					["tags", "one"],
					["tags", "two"],
				]),
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ tags: ["one", "two"], file: null });
		},
	);

	test("returns 403 when upstream consumed the raw body without caching it", async () => {
		const app = buildApp({}, async (c, next) => {
			if (c.req.method === "POST") await c.req.raw.text();
			await next();
		});
		const { token, cookieHeader } = await issueToken(app);
		const res = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookieHeader },
			body: new URLSearchParams({ csrf_token: token }),
		});
		expect(res.status).toBe(403);
		expect(await res.text()).toBe("Invalid CSRF token");
	});

	test("allows a larger form when the configured limit is increased", async () => {
		const app = buildApp({ maxFormBodyBytes: 128 * 1024 });
		const { token, cookieHeader } = await issueToken(app);
		const res = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookieHeader },
			body: new URLSearchParams({ csrf_token: token, padding: "x".repeat(65_536) }),
		});
		expect(res.status).toBe(200);
	});

	test("counts encoded bytes instead of characters", async () => {
		const app = buildApp({ maxFormBodyBytes: 120 });
		const { token, cookieHeader } = await issueToken(app);
		const body = `csrf_token=${token}&text=${"あ".repeat(10)}`;
		expect(body.length).toBeLessThan(120);
		const res = await app.request("/action", {
			method: "POST",
			headers: { Cookie: cookieHeader, "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		expect(res.status).toBe(403);
	});

	test.each([undefined, "1", "999999"])(
		"stops reading an oversized stream regardless of Content-Length %s",
		async (contentLength) => {
			const app = buildApp({ maxFormBodyBytes: 1024 });
			let pulls = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull: (controller) => {
					pulls++;
					controller.enqueue(new Uint8Array(1024));
					if (pulls === 100) controller.close();
				},
			});
			const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
			if (contentLength) headers.set("content-length", contentLength);
			const init = { method: "POST", headers, body: stream, duplex: "half" };
			const request = new Request("http://localhost/action", init);
			const res = await app.request(request);
			expect(res.status).toBe(403);
			expect(pulls).toBeLessThan(10);
			await request.body?.cancel();
		},
	);

	test.each(["valid", "invalid"])(
		"does not read the body when a %s header token is provided",
		async (kind) => {
			const app = buildApp({ maxFormBodyBytes: 1 });
			const { token, cookieHeader } = await issueToken(app);
			let pulls = 0;
			const body = new ReadableStream<Uint8Array>(
				{
					pull: (controller) => {
						pulls++;
						controller.error(new Error("Body must not be read"));
					},
				},
				{ highWaterMark: 0 },
			);
			const init = {
				method: "POST",
				body,
				duplex: "half",
				headers: {
					Cookie: cookieHeader,
					"X-CSRF-Token": kind === "valid" ? token : "invalid",
					"content-type": "multipart/form-data",
				},
			};
			const res = await app.request(new Request("http://localhost/action", init));
			expect(res.status).toBe(kind === "valid" ? 200 : 403);
			expect(pulls).toBe(0);
		},
	);

	test("returns 403 for malformed multipart data", async () => {
		const app = buildApp();
		const res = await app.request("/action", {
			method: "POST",
			headers: { "content-type": "multipart/form-data" },
			body: "invalid",
		});
		expect(res.status).toBe(403);
	});

	test.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxFormBodyBytes %s",
		(maxFormBodyBytes) => {
			expect(() => buildApp({ maxFormBodyBytes })).toThrow(
				"maxFormBodyBytes must be a positive safe integer",
			);
		},
	);

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
		const app = buildApp({
			exceptions: [{ origin: "https://provider.example", path: "/callback" }],
		});

		const res = await app.request("/callback", {
			method: "POST",
			headers: { Origin: "https://provider.example" },
		});

		expect(res.status).toBe(200);
	});

	test("results in 403 when origin matches but path differs, since it is not an exception", async () => {
		const app = buildApp({
			exceptions: [{ origin: "https://provider.example", path: "/callback" }],
		});

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
