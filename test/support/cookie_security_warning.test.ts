/**
 * Verifies `warnInsecureCookieInProduction`, a runtime safeguard (SEC-202) that warns once
 * when running in a production-like environment with cookie secure left unset (docs/testing.md L1).
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { warnInsecureCookieInProduction } from "../../src/support/cookie_security_warning.js";

describe("warnInsecureCookieInProduction", () => {
	const originalNodeEnv = process.env.NODE_ENV;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
	});

	test("warns via console.warn once per context when NODE_ENV=production and secure is unset", () => {
		process.env.NODE_ENV = "production";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		warnInsecureCookieInProduction(undefined, "warnInsecureCookieInProduction:production-unset");
		warnInsecureCookieInProduction(undefined, "warnInsecureCookieInProduction:production-unset");

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain("secure attribute is not set");

		warnSpy.mockRestore();
	});

	test("does not call console.warn when secure is explicitly set", () => {
		process.env.NODE_ENV = "production";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		warnInsecureCookieInProduction(true, "warnInsecureCookieInProduction:explicitly-set");

		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test("does not call console.warn even with secure unset when not production-like", () => {
		process.env.NODE_ENV = "development";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		warnInsecureCookieInProduction(undefined, "warnInsecureCookieInProduction:development");

		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test("the default behavior does not reject (does not throw)", () => {
		process.env.NODE_ENV = "production";
		expect(() =>
			warnInsecureCookieInProduction(undefined, "warnInsecureCookieInProduction:does-not-throw"),
		).not.toThrow();
	});
});
