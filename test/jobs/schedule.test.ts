/**
 * Verifies `Schedule` and `matchesCron`, the dependency-free minimal cron matcher
 * (`src/jobs/schedule.ts`). The `run` loop is verified with `vi.useFakeTimers`,
 * checking, as in `sqlite_database_job_worker.test.ts`, the wait until the top of
 * the minute, the 60-second-interval driving, and stopping via abort.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Schedule, matchesCron } from "../../src/jobs/schedule.js";

describe("matchesCron", () => {
	test("* * * * * always matches", () => {
		expect(matchesCron("* * * * *", new Date("2026-07-07T03:04:00"))).toBe(true);
	});

	test("matches when the minute/hour numbers agree", () => {
		expect(matchesCron("30 9 * * *", new Date("2026-07-07T09:30:00"))).toBe(true);
	});

	test("doesn't match when the minute/hour numbers disagree", () => {
		expect(matchesCron("30 9 * * *", new Date("2026-07-07T09:31:00"))).toBe(false);
		expect(matchesCron("30 9 * * *", new Date("2026-07-07T10:30:00"))).toBe(false);
	});

	test("a comma list matches multiple values", () => {
		expect(matchesCron("1,15,30 * * * *", new Date("2026-07-07T00:15:00"))).toBe(true);
		expect(matchesCron("1,15,30 * * * *", new Date("2026-07-07T00:16:00"))).toBe(false);
	});

	test("a range spec matches within that range", () => {
		expect(matchesCron("* 9-17 * * *", new Date("2026-07-07T12:00:00"))).toBe(true);
		expect(matchesCron("* 9-17 * * *", new Date("2026-07-07T18:00:00"))).toBe(false);
	});

	test("a step spec matches the step interval", () => {
		expect(matchesCron("*/15 * * * *", new Date("2026-07-07T00:30:00"))).toBe(true);
		expect(matchesCron("*/15 * * * *", new Date("2026-07-07T00:31:00"))).toBe(false);
	});

	test("matches a combined range+step spec", () => {
		expect(matchesCron("* 9-17/2 * * *", new Date("2026-07-07T11:00:00"))).toBe(true);
		expect(matchesCron("* 9-17/2 * * *", new Date("2026-07-07T12:00:00"))).toBe(false);
	});

	test("both 0 and 7 in the day-of-week field are treated as Sunday", () => {
		const sunday = new Date("2026-07-05T00:00:00");
		expect(sunday.getDay()).toBe(0);
		expect(matchesCron("* * * * 0", sunday)).toBe(true);
		expect(matchesCron("* * * * 7", sunday)).toBe(true);
	});

	test("when both day-of-month and day-of-week are non-*, they match with OR semantics (Vixie cron compatible)", () => {
		/** 2026-07-15 is a Wednesday (day-of-week=Friday doesn't match, but the date matches the 15th, so it matches) */
		const fifteenth = new Date("2026-07-15T00:00:00");
		expect(fifteenth.getDay()).toBe(3);
		expect(matchesCron("0 0 15 * 5", fifteenth)).toBe(true);

		/** 2026-07-17 is a Friday (the date doesn't match, but day-of-week matches, so it matches) */
		const friday = new Date("2026-07-17T00:00:00");
		expect(friday.getDay()).toBe(5);
		expect(matchesCron("0 0 15 * 5", friday)).toBe(true);

		/** A day matching neither doesn't match */
		const neither = new Date("2026-07-16T00:00:00");
		expect(matchesCron("0 0 15 * 5", neither)).toBe(false);
	});

	test("an expression without 5 fields throws", () => {
		expect(() => matchesCron("* * * *", new Date())).toThrow();
	});

	test("an out-of-range number (60 minutes) throws", () => {
		expect(() => matchesCron("60 * * * *", new Date())).toThrow();
	});

	test("named values (e.g. weekday names) throw", () => {
		expect(() => matchesCron("0 0 * * SUN", new Date())).toThrow();
	});

	test("extended syntax like L throws", () => {
		expect(() => matchesCron("0 0 L * *", new Date())).toThrow();
	});
});

describe("Schedule", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("registering a duplicate name throws", () => {
		expect(
			() =>
				new Schedule([
					{ name: "dup", cron: "* * * * *", run: () => undefined },
					{ name: "dup", cron: "0 0 * * *", run: () => undefined },
				]),
		).toThrow(/dup/);
	});

	test("cron is compiled only once at registration, and repeated calls to runDue produce the same match results", async () => {
		const calls: string[] = [];
		const schedule = new Schedule([
			{ name: "everyMinute", cron: "*/15 * * * *", run: () => void calls.push("run") },
		]);

		/** Confirms across multiple minutes that the result matches matchesCron (which compiles each time). */
		const minutes = ["2026-07-07T00:00:00", "2026-07-07T00:05:00", "2026-07-07T00:15:00"];
		for (const minute of minutes) {
			const now = new Date(minute);
			const executed = await schedule.runDue(now);
			expect(executed).toBe(matchesCron("*/15 * * * *", now) ? 1 : 0);
		}
	});

	test("runDue executes only matching entries and returns the count of entries run", async () => {
		const calledA: string[] = [];
		const calledB: string[] = [];
		const schedule = new Schedule([
			{ name: "a", cron: "0 0 * * *", run: () => void calledA.push("a") },
			{ name: "b", cron: "* * * * *", run: () => void calledB.push("b") },
		]);

		const executed = await schedule.runDue(new Date("2026-07-07T09:30:00"));

		expect(executed).toBe(1);
		expect(calledA).toEqual([]);
		expect(calledB).toEqual(["b"]);
	});

	test("an entry throwing is passed to onError, and other entries continue running", async () => {
		const calledAfter: string[] = [];
		const onError = vi.fn();
		const schedule = new Schedule([
			{
				name: "failing",
				cron: "* * * * *",
				run: () => {
					throw new Error("failure");
				},
			},
			{ name: "after", cron: "* * * * *", run: () => void calledAfter.push("after") },
		]);

		const executed = await schedule.runDue(new Date(), { onError });

		expect(executed).toBe(2);
		expect(onError).toHaveBeenCalledWith("failing", expect.any(Error));
		expect(calledAfter).toEqual(["after"]);
	});

	test("the run loop fires runDue-equivalent processing at the top of the minute, and stops on abort", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-07T09:30:15.000"));

		const calls: string[] = [];
		const schedule = new Schedule([
			{ name: "everyMinute", cron: "* * * * *", run: () => void calls.push("run") },
		]);
		const controller = new AbortController();

		const runPromise = schedule.run({ signal: controller.signal });

		/** 45 seconds remain until the top of the minute (09:31:00). Advance to there first and confirm the first firing. */
		await vi.advanceTimersByTimeAsync(45_000);
		expect(calls).toEqual(["run"]);

		/** Confirm the second firing 60 seconds later, then abort to stop the loop. */
		await vi.advanceTimersByTimeAsync(60_000);
		expect(calls).toEqual(["run", "run"]);

		controller.abort();
		await vi.advanceTimersByTimeAsync(0);
		await runPromise;
	});
});
