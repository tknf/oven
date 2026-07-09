/**
 * Tests for `ErrorPages` (the `onError` convention and shared error page).
 * (docs/testing.md L1). Drives a Hono app directly through `app.request()` and checks the
 * response and what gets recorded by the logger.
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vite-plus/test";
import { ErrorPages } from "../../src/routing/error_handler.js";
import { Logger, type LogFields, type LogLevel } from "../../src/logging/logger.js";

/** Test `Logger` stub that just records the arguments passed to `error`. */
class RecordingLogger extends Logger {
	readonly writes: { level: LogLevel; message: string; fields: LogFields }[] = [];

	child(fields: LogFields): RecordingLogger {
		return new RecordingLogger({ ...this.fields, ...fields });
	}

	protected write(level: LogLevel, message: string, fields: LogFields): void {
		this.writes.push({ level, message, fields });
	}
}

describe("ErrorPages#onError", () => {
	test("an HTTPException's getResponse() response is returned as-is", async () => {
		const app = new Hono();
		app.onError(new ErrorPages().onError);
		app.get("/", () => {
			throw new HTTPException(401, { message: "authentication required" });
		});

		const res = await app.request("/");

		expect(res.status).toBe(401);
		expect(await res.text()).toBe("authentication required");
	});

	test("a generic error returns 500 with the shared page, without leaking the message/stack in the response", async () => {
		const app = new Hono();
		app.onError(new ErrorPages().onError);
		app.get("/", () => {
			throw new Error("internal secret details");
		});

		const res = await app.request("/");
		const body = await res.text();

		expect(res.status).toBe(500);
		expect(body).toContain("An unexpected error occurred");
		expect(body).not.toContain("internal secret details");
	});

	test("passing a logger records a generic error as an error-level log", async () => {
		const logger = new RecordingLogger();
		const app = new Hono();
		app.onError(new ErrorPages({ logger: () => logger }).onError);
		app.get("/boom", () => {
			throw new Error("internal secret details");
		});

		await app.request("/boom");

		expect(logger.writes).toHaveLength(1);
		expect(logger.writes[0]?.level).toBe("error");
		expect(logger.writes[0]?.message).toBe("internal secret details");
		expect(logger.writes[0]?.fields).toMatchObject({ method: "GET", path: "/boom" });
		expect(logger.writes[0]?.fields.stack).toEqual(expect.any(String));
	});

	test("without a logger, nothing is recorded and only the 500 page is returned", async () => {
		const app = new Hono();
		app.onError(new ErrorPages().onError);
		app.get("/", () => {
			throw new Error("boom");
		});

		const res = await app.request("/");

		expect(res.status).toBe(500);
	});
});

describe("ErrorPages#notFound", () => {
	test("an undefined route returns the 404 page", async () => {
		const app = new Hono();
		app.notFound(new ErrorPages().notFound);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/not-registered");
		const body = await res.text();

		expect(res.status).toBe(404);
		expect(body).toContain("Page not found");
	});

	test("html lang follows en when languageDetector or similar detects en", async () => {
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("language", "en");
			await next();
		});
		app.notFound(new ErrorPages().notFound);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/not-registered");
		const body = await res.text();

		expect(body).toContain('<html lang="en">');
	});

	test("html lang defaults to en when languageDetector isn't applied (c.get('language') is undefined)", async () => {
		const app = new Hono();
		app.notFound(new ErrorPages().notFound);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/not-registered");
		const body = await res.text();

		expect(body).toContain('<html lang="en">');
	});

	test("falls back to en even when language holds an invalid value (an attribute-injection attempt)", async () => {
		const app = new Hono();
		app.use("*", async (c, next) => {
			c.set("language", '"><script>alert(1)</script>');
			await next();
		});
		app.notFound(new ErrorPages().notFound);
		app.get("/", (c) => c.text("ok"));

		const res = await app.request("/not-registered");
		const body = await res.text();

		expect(body).toContain('<html lang="en">');
		expect(body).not.toContain("<script>");
	});
});
