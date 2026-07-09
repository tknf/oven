/**
 * Tests for `formatClockDuration`/`formatWordedDurationJa` (duration formatting helpers).
 */
import { describe, expect, test } from "vite-plus/test";
import { formatClockDuration, formatWordedDurationJa } from "../../src/helpers/duration.js";

describe("formatClockDuration", () => {
	test("0 seconds is 0:00", () => {
		expect(formatClockDuration(0)).toBe("0:00");
	});

	test("59 seconds is M:SS format (under an hour)", () => {
		expect(formatClockDuration(59)).toBe("0:59");
	});

	test("exactly 1 hour is H:MM:SS format", () => {
		expect(formatClockDuration(3600)).toBe("1:00:00");
	});

	test("1 hour 59 minutes 59 seconds", () => {
		expect(formatClockDuration(3600 + 59 * 60 + 59)).toBe("1:59:59");
	});

	test("negative/non-finite values are treated as 0", () => {
		expect(formatClockDuration(-10)).toBe("0:00");
		expect(formatClockDuration(Number.NaN)).toBe("0:00");
	});
});

describe("formatWordedDurationJa", () => {
	test("under 60 seconds is '1分未満' (less than a minute)", () => {
		expect(formatWordedDurationJa(59)).toBe("1分未満");
	});

	test("exactly 60 seconds is '1分' (1 minute)", () => {
		expect(formatWordedDurationJa(60)).toBe("1分");
	});

	test("under 1 hour shows minutes only", () => {
		expect(formatWordedDurationJa(59 * 60)).toBe("59分");
	});

	test("exactly 1 hour is '1時間0分' (1 hour 0 minutes)", () => {
		expect(formatWordedDurationJa(3600)).toBe("1時間0分");
	});

	test("1.5 hours is '1時間30分' (sub-second is truncated)", () => {
		expect(formatWordedDurationJa(3600 + 30 * 60 + 45)).toBe("1時間30分");
	});
});
