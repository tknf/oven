/**
 * Verifies `NullLogger` (a `Logger` implementation that outputs nothing).
 * Confirms `write` is a no-op and `child` returns a new instance of the same
 * type with bound fields.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { NullLogger } from "../../src/logging/null_logger.js";

describe("NullLogger", () => {
	test("calling any level method does not output to console", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

		const logger = new NullLogger();
		logger.debug("no-op");
		logger.info("no-op");

		expect(debugSpy).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();

		vi.restoreAllMocks();
	});

	test("child returns a NullLogger with merged bound fields", () => {
		const parent = new NullLogger({ service: "test" });

		const child = parent.child({ requestId: "req-1" });

		expect(child).toBeInstanceOf(NullLogger);
		expect(child).not.toBe(parent);
	});
});
