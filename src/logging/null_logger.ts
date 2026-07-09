import { Logger, type LogFields } from "./logger.js";

/**
 * `Logger` implementation that emits nothing. Intended for use as a placeholder in tests or
 * when no logger has been configured (so APIs requiring a `Logger` don't need null checks).
 */
export class NullLogger extends Logger {
	child(fields: LogFields): NullLogger {
		return new NullLogger({ ...this.fields, ...fields }, this.options);
	}

	protected write(): void {
		// No-op.
	}
}
