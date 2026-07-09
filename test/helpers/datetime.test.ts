/**
 * Tests for `formatDateTime` (the date/time formatting helper).
 */
import { describe, expect, test } from "vite-plus/test";
import { formatDateTime } from "../../src/helpers/datetime.js";

describe("formatDateTime", () => {
	test("the same epoch ms renders a different displayed time depending on timeZone", () => {
		const epochMs = Date.UTC(2026, 0, 1, 12, 0, 0);

		const tokyo = formatDateTime(epochMs, { timeZone: "Asia/Tokyo", locale: "ja-JP" });
		const losAngeles = formatDateTime(epochMs, {
			timeZone: "America/Los_Angeles",
			locale: "ja-JP",
		});

		expect(tokyo).not.toBe(losAngeles);
		expect(tokyo).toContain("21:00");
	});

	test("formats without throwing even when locale is omitted", () => {
		const epochMs = Date.UTC(2026, 0, 1, 0, 0, 0);

		expect(() => formatDateTime(epochMs, { timeZone: "Asia/Tokyo" })).not.toThrow();
	});
});
