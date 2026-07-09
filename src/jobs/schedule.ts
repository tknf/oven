/**
 * A minimal, runtime-independent scheduler for declaratively writing an explicit table
 * mapping cron expressions to handlers. Implements its own zero-dependency minimal cron
 * matcher (`matchesCron`)
 * and keeps time-matching logic itself in core.
 *
 * The existing `ScheduledDispatcher` (`src/cloudflare/scheduled_dispatcher.ts`) is a
 * table of Cloudflare cron trigger strings to handlers (driven from a Workers
 * `scheduled` handler), and complements this class. `Schedule` can be driven either
 * from a long-running loop in Node etc., or by calling `runDue` directly from a CF
 * `scheduled` handler.
 */

/** A single registered schedule entry. */
export type ScheduleEntry = {
	/** Identifying name (for logs and error messages). `Schedule`'s constructor throws on duplicate names. */
	name: string;
	/** A 5-field cron expression (minute hour day month weekday). See `matchesCron` for the syntax. */
	cron: string;
	/**
	 * The action to run on a match. To periodically enqueue a job, write
	 * `run: () => queue.enqueue(job, payload)`.
	 */
	run: () => void | Promise<void>;
};

/** Hook for reporting errors that occur during `Schedule#run`'s long-running loop. */
export type ScheduleRunErrorHook = (name: string, error: unknown) => void;

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Returns a Promise that resolves after `ms` milliseconds, or as soon as `signal` is
 * aborted, whichever comes first. Reliably clears the timer on abort and the event
 * listener on timeout (same convention as `sleep` in `sqlite_database_job_worker.ts`).
 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Parses a single cron field expression (e.g. `1,10-20/5`) and returns a predicate that
 * determines whether `value` (the field's actual value) matches. `min`/`max` are the
 * range of values this field can take (used to detect invalid numbers). `fieldName` is
 * the label included in error messages.
 */
const compileField = (
	fieldName: string,
	expression: string,
	min: number,
	max: number,
): ((value: number) => boolean) => {
	if (expression.length === 0) {
		throw new Error(`Invalid cron expression (the ${fieldName} field is empty)`);
	}

	const matchers = expression.split(",").map((term) => compileTerm(fieldName, term, min, max));
	return (value: number): boolean => matchers.some((matches) => matches(value));
};

/** Parses a single comma-separated element (a combination of `*`, number, range, and step). */
const compileTerm = (
	fieldName: string,
	term: string,
	min: number,
	max: number,
): ((value: number) => boolean) => {
	const [rangePart, stepPart] = term.split("/");
	if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
		throw new Error(`Invalid cron expression (invalid step "${term}" in the ${fieldName} field)`);
	}
	const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
	if (step <= 0) {
		throw new Error(`Invalid cron expression (invalid step "${term}" in the ${fieldName} field)`);
	}

	const [rangeStart, rangeEnd] = parseRange(fieldName, rangePart, min, max);

	return (value: number): boolean =>
		value >= rangeStart && value <= rangeEnd && (value - rangeStart) % step === 0;
};

/** Resolves the range part (`*`, a single number, or `9-17`) to `[start, end]`. Out-of-range values and named values are unsupported. */
const parseRange = (
	fieldName: string,
	rangePart: string,
	min: number,
	max: number,
): [number, number] => {
	if (rangePart === "*") {
		return [min, max];
	}

	const bounds = rangePart.split("-");
	if (bounds.length > 2 || bounds.some((bound) => bound.length === 0)) {
		throw new Error(`Invalid cron expression (invalid ${fieldName} field "${rangePart}")`);
	}

	const numbers = bounds.map((bound) => {
		if (!/^\d+$/.test(bound)) {
			throw new Error(`Invalid cron expression (invalid ${fieldName} field "${rangePart}")`);
		}
		return Number.parseInt(bound, 10);
	});

	const [start, end = start] = numbers;
	if (start < min || start > max || end < min || end > max || start > end) {
		throw new Error(
			`Invalid cron expression (the ${fieldName} field "${rangePart}" must be within ${min}-${max})`,
		);
	}

	return [start, end];
};

/** Weekday-field-specific: cron's `0` and `7` both mean Sunday (Vixie cron compatibility). */
const normalizeWeekday = (matches: (value: number) => boolean): ((value: number) => boolean) => {
	return (value: number): boolean => matches(value) || (value === 0 && matches(7));
};

/**
 * Determines, at minute granularity, whether a 5-field cron expression (minute hour day
 * month weekday) matches `date`.
 *
 * Supported syntax is `*`, numbers, comma lists (`1,15,30`), ranges (`9-17`), steps
 * (`* /15`, `9-17/2` — a slash right after an asterisk), and combinations of these
 * (`1,10-20/5`). Month/weekday names (e.g. `JAN`/`SUN`) and extended syntax such as
 * `L`/`W`/`#` are unsupported and throw at parse time.
 *
 * When both the day and weekday fields hold a value other than `*`, they are combined
 * with OR (Vixie cron-compatible semantics; e.g. `0 0 1,15 * 5` matches "the 1st or
 * 15th of every month" OR "every Friday").
 *
 * Uses `date`'s local time (`getMinutes()` etc.) as-is, so the result depends on the
 * runtime's timezone. If you need UTC-based matching, manage the timezone on the
 * caller's side.
 */
export const matchesCron = (expression: string, date: Date): boolean =>
	compileCron(expression)(date);

/**
 * Parses and compiles a cron expression exactly once, returning a predicate that can
 * then be evaluated by passing `date`. `matchesCron` is a thin wrapper that discards
 * this function's result after a single use (kept as a public API for backward
 * compatibility). Call sites that are invoked frequently (e.g. `Schedule#runDue`)
 * should retain and reuse this function's return value to avoid re-parsing the fields.
 */
const compileCron = (expression: string): ((date: Date) => boolean) => {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(
			`Invalid cron expression (expected 5 fields, got ${fields.length}: "${expression}")`,
		);
	}
	const [minuteExpr, hourExpr, dayExpr, monthExpr, weekdayExpr] = fields;

	const matchesMinute = compileField("minute", minuteExpr, 0, 59);
	const matchesHour = compileField("hour", hourExpr, 0, 23);
	const matchesDay = compileField("day", dayExpr, 1, 31);
	const matchesMonth = compileField("month", monthExpr, 1, 12);
	const matchesWeekday = normalizeWeekday(compileField("weekday", weekdayExpr, 0, 7));

	const dayIsWildcard = dayExpr === "*";
	const weekdayIsWildcard = weekdayExpr === "*";

	return (date: Date): boolean => {
		if (!matchesMinute(date.getMinutes()) || !matchesHour(date.getHours())) {
			return false;
		}
		if (!matchesMonth(date.getMonth() + 1)) {
			return false;
		}

		if (dayIsWildcard || weekdayIsWildcard) {
			return (
				(dayIsWildcard || matchesDay(date.getDate())) &&
				(weekdayIsWildcard || matchesWeekday(date.getDay()))
			);
		}
		return matchesDay(date.getDate()) || matchesWeekday(date.getDay());
	};
};

/**
 * Holds a table of cron expressions to handlers and runs the entries whose time
 * matches. Runtime-independent: `runDue` can be called either from a Node long-running
 * loop or from a Cloudflare Workers `scheduled` handler.
 */
export class Schedule {
	/**
	 * Pairs of entries and their cron expression compiled exactly once into a
	 * predicate. `runDue` can be called every minute while only evaluating the
	 * already-cached predicate here — no re-parsing of fields via `compileField`
	 * occurs.
	 */
	private readonly entries: readonly { entry: ScheduleEntry; matches: (date: Date) => boolean }[];

	constructor(entries: ScheduleEntry[]) {
		const seen = new Set<string>();
		this.entries = entries.map((entry) => {
			if (seen.has(entry.name)) {
				throw new Error(`Duplicate schedule name "${entry.name}"`);
			}
			seen.add(entry.name);
			/** Compiling once at registration time surfaces an invalid cron expression early. */
			return { entry, matches: compileCron(entry.cron) };
		});
	}

	/**
	 * Runs, in registration order and sequentially, every entry whose cron matches
	 * `now` (default `new Date()`), and returns the number of entries run. Because
	 * matching is at minute granularity, calling this more than once within the same
	 * minute causes duplicate execution (the caller must avoid that). If an entry's
	 * `run` throws or rejects, the error is passed to `options.onError` and execution
	 * continues with the remaining entries.
	 */
	readonly runDue = async (
		now: Date = new Date(),
		options: { onError?: ScheduleRunErrorHook } = {},
	): Promise<number> => {
		let executed = 0;
		for (const { entry, matches } of this.entries) {
			if (!matches(now)) continue;

			executed += 1;
			try {
				await entry.run();
			} catch (error) {
				options.onError?.(entry.name, error);
			}
		}
		return executed;
	};

	/**
	 * A long-running loop for processes such as Node. On startup, first waits until the
	 * top of the next minute, then calls `runDue` every 60 seconds after that. When
	 * `signal` is aborted, the timer is cleared immediately and the loop stops. If
	 * aborted while `runDue` is running, the in-flight entry is allowed to finish before
	 * the loop exits.
	 */
	readonly run = async (options: {
		signal: AbortSignal;
		onError?: ScheduleRunErrorHook;
	}): Promise<void> => {
		const { signal, onError } = options;

		while (!signal.aborted) {
			const now = new Date();
			const msUntilNextMinute =
				DEFAULT_INTERVAL_MS - (now.getSeconds() * 1000 + now.getMilliseconds());
			await sleep(msUntilNextMinute, signal);
			if (signal.aborted) break;

			await this.runDue(new Date(), { onError });
		}
	};
}
