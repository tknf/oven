/**
 * Verifies `ScheduledDispatcher` (generating dispatch from a cron-expression-to-handler
 * table) (docs/testing.md L1). `ScheduledController` is mimicked with a minimal in-test stub.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { ScheduledDispatcher } from "../../src/cloudflare/scheduled_dispatcher.js";

/** A minimal stub satisfying `ScheduledController`. */
const buildController = (cron: string, scheduledTime = 0): ScheduledController => ({
	cron,
	scheduledTime,
	noRetry: vi.fn(),
});

describe("ScheduledDispatcher", () => {
	test("calls the handler matching controller.cron with scheduledTime", async () => {
		const dailyHandler = vi.fn(async () => undefined);
		const dispatcher = new ScheduledDispatcher({ "0 0 * * *": dailyHandler });

		await dispatcher.dispatch(buildController("0 0 * * *", 1720000000000));

		expect(dailyHandler).toHaveBeenCalledTimes(1);
		expect(dailyHandler).toHaveBeenCalledWith(1720000000000);
	});

	test("throws when a cron expression not in the table arrives", async () => {
		const dispatcher = new ScheduledDispatcher({ "0 0 * * *": vi.fn() });

		await expect(dispatcher.dispatch(buildController("*/5 * * * *"))).rejects.toThrow(
			/\*\/5 \* \* \* \*/,
		);
	});

	test("can register multiple cron expressions, and only their corresponding handler is called", async () => {
		const dailyHandler = vi.fn(async () => undefined);
		const hourlyHandler = vi.fn(async () => undefined);
		const dispatcher = new ScheduledDispatcher({
			"0 0 * * *": dailyHandler,
			"0 * * * *": hourlyHandler,
		});

		await dispatcher.dispatch(buildController("0 * * * *"));

		expect(hourlyHandler).toHaveBeenCalledTimes(1);
		expect(dailyHandler).not.toHaveBeenCalled();
	});
});
