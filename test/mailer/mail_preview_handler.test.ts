/**
 * Tests for `MailPreviewHandler` (the development mail preview). Follows the
 * `RouteHandler` testing convention (`app.route()` + `app.request()`); see
 * `test/routing/route_handler.test.ts`.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { MailPreviewHandler } from "../../src/mailer/mail_preview_handler.js";
import type { MailMessage } from "../../src/mailer/mailer.js";

/** Factory that builds a test-only `MailMessage` with base fields overridable. */
const buildMessage = (overrides: Partial<MailMessage> = {}): MailMessage => ({
	from: "no-reply@example.com",
	to: "listener@example.com",
	subject: "Sample subject",
	textBody: "Sample text body",
	...overrides,
});

describe("MailPreviewHandler", () => {
	test("GET / lists every registered preview name as a link", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					welcome: () => buildMessage(),
					reminder: () => buildMessage(),
				},
			}),
		);

		const res = await app.request("/mails");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain('href="welcome"');
		expect(body).toContain(">welcome<");
		expect(body).toContain('href="reminder"');
		expect(body).toContain(">reminder<");
	});

	test("GET / HTML-escapes preview names", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					"<script>alert(1)</script>": () => buildMessage(),
				},
			}),
		);

		const res = await app.request("/mails");
		const body = await res.text();

		expect(body).not.toContain("<script>alert(1)</script>");
		expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
	});

	test("GET /:name returns text/html when htmlBody is present, including subject and recipients", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					welcome: () =>
						buildMessage({
							subject: "Welcome",
							to: ["a@example.com", "b@example.com"],
							htmlBody: "<p>Hello</p>",
						}),
				},
			}),
		);

		const res = await app.request("/mails/welcome");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(body).toContain("<p>Hello</p>");
		expect(body).toContain("Subject: Welcome");
		expect(body).toContain("To: a@example.com, b@example.com");
	});

	test("a message with only textBody returns text/plain", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					plain: () => buildMessage({ subject: "Plain", textBody: "Text body only" }),
				},
			}),
		);

		const res = await app.request("/mails/plain");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(body).toContain("Text body only");
		expect(body).toContain("Subject: Plain");
	});

	test("passing ?part=text shows textBody even when htmlBody is present", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					welcome: () =>
						buildMessage({
							htmlBody: "<p>HTML version</p>",
							textBody: "Text version",
						}),
				},
			}),
		);

		const res = await app.request("/mails/welcome?part=text");
		const body = await res.text();

		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(body).toContain("Text version");
		expect(body).not.toContain("<p>HTML version</p>");
	});

	test("an unknown preview name returns 404", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					welcome: () => buildMessage(),
				},
			}),
		);

		const res = await app.request("/mails/unknown");

		expect(res.status).toBe(404);
	});

	test("inherited Object.prototype member names (constructor, etc.) return 404", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					welcome: () => buildMessage(),
				},
			}),
		);

		const constructorRes = await app.request("/mails/constructor");
		const toStringRes = await app.request("/mails/toString");
		const hasOwnPropertyRes = await app.request("/mails/hasOwnProperty");

		expect(constructorRes.status).toBe(404);
		expect(toStringRes.status).toBe(404);
		expect(hasOwnPropertyRes.status).toBe(404);
	});

	test("also supports an async factory (one that returns a Promise)", async () => {
		const app = new Hono();
		app.route(
			"/mails",
			new MailPreviewHandler({
				previews: {
					async_preview: async () => {
						await Promise.resolve();
						return buildMessage({ subject: "Async preview", htmlBody: "<p>Async</p>" });
					},
				},
			}),
		);

		const res = await app.request("/mails/async_preview");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("<p>Async</p>");
		expect(body).toContain("Subject: Async preview");
	});
});
