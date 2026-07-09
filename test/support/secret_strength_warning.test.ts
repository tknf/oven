/**
 * Verifies `warnWeakSecrets`, a runtime safeguard (SEC-203) that warns once when secrets
 * are insufficiently strong (docs/testing.md L1).
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { warnWeakSecrets } from "../../src/support/secret_strength_warning.js";

describe("warnWeakSecrets", () => {
	test("warns via console.warn once per context when a secret shorter than 32 characters is passed", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		warnWeakSecrets(["short-secret"], "warnWeakSecrets:short");
		warnWeakSecrets(["short-secret"], "warnWeakSecrets:short");

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toContain("secret is too short");

		warnSpy.mockRestore();
	});

	test("does not call console.warn when all secrets are at least 32 characters", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		warnWeakSecrets(["a".repeat(32)], "warnWeakSecrets:sufficient-length");

		expect(warnSpy).not.toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	test("the default behavior does not reject (does not throw)", () => {
		expect(() => warnWeakSecrets(["x"], "warnWeakSecrets:does-not-throw")).not.toThrow();
	});
});
