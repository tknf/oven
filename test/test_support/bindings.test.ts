/**
 * Verifies `stubBinding` from `src/test/bindings.ts`.
 */
import { describe, expect, test } from "vite-plus/test";
import { stubBinding } from "../../src/test/bindings.js";

describe("stubBinding", () => {
	test("accessing any property returns a function", () => {
		const stub = stubBinding<{
			get: (key: string) => string;
			put: (key: string, value: string) => void;
		}>();

		expect(typeof stub.get).toBe("function");
		expect(typeof stub.put).toBe("function");
	});

	test("calling a stubbed function does not throw", () => {
		const stub = stubBinding<{ get: (key: string) => string }>();

		expect(() => stub.get("some-key")).not.toThrow();
	});
});
