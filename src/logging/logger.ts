/** Log level, corresponding to `console.debug`/`console.info`/`console.warn`/`console.error`. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Additional fields for a structured log entry. Keys and values are free-form as long as the output backend can interpret them. */
export type LogFields = Record<string, unknown>;

/**
 * Default sensitive key names to mask when `redact` is `true` (substring match, case-insensitive).
 * Covers things like passwords, tokens, auth headers, and cookies whose values should never be
 * written to logs as-is.
 */
const DEFAULT_REDACT_KEYS = ["password", "token", "authorization", "cookie", "secret", "apikey"];

/** Placeholder string written in place of a masked value. */
const REDACTED_PLACEHOLDER = "[REDACTED]";

export type LoggerOptions = {
	/**
	 * Opt-in masking of sensitive fields. When unspecified (the default), fields are emitted
	 * unmodified (preserving existing behavior). When `true`, the default key set
	 * (`DEFAULT_REDACT_KEYS`) is masked. When given a string array, those key names are masked
	 * instead (matched against field keys by substring, case-insensitive).
	 *
	 * Masking only inspects top-level field keys; it does not recurse into nested objects
	 * (a deliberate simplification to avoid over-engineering).
	 */
	redact?: boolean | string[];
};

/**
 * Abstract base for structured loggers, following the same single idiom (abstract base class +
 * inheritance) used by `Mailer`/`Storage`/`KeyValueStore`.
 *
 * The `fields` (bound fields) passed to the constructor are automatically merged into every log
 * entry subsequently emitted from this instance. `debug`/`info`/`warn`/`error` are all thin
 * wrappers that merge the bound fields with the call-site `fields` and delegate to the abstract
 * `write` method; the actual output mechanism (console, external logging service, etc.) is the
 * responsibility of the subclass implementing `write`.
 *
 * `child` is the contract for creating a new logger with per-request information (e.g. the
 * `requestId` issued by `hono/request-id`) added to the bound fields. IDs should not be generated
 * manually (the expectation is to use `hono/request-id`).
 *
 * `fields` are emitted unmodified by default. It is the caller's responsibility not to pass
 * sensitive values such as passwords, tokens, or Authorization headers, but `options.redact` can
 * be used to opt into masking (see `LoggerOptions`).
 *
 * @example
 * ```ts
 * const requestLogger = logger.child({ requestId: c.get("requestId") });
 * requestLogger.info("item created", { itemId });
 * ```
 */
export abstract class Logger {
	protected readonly fields: LogFields;
	protected readonly options: LoggerOptions;

	constructor(fields: LogFields = {}, options: LoggerOptions = {}) {
		this.fields = fields;
		this.options = options;
	}

	debug(message: string, fields?: LogFields): void {
		this.write("debug", message, this.mergeFields(fields));
	}

	info(message: string, fields?: LogFields): void {
		this.write("info", message, this.mergeFields(fields));
	}

	warn(message: string, fields?: LogFields): void {
		this.write("warn", message, this.mergeFields(fields));
	}

	error(message: string, fields?: LogFields): void {
		this.write("error", message, this.mergeFields(fields));
	}

	/** Returns a new logger of the same type with `fields` merged into the bound fields. */
	abstract child(fields: LogFields): Logger;

	/** Performs the actual output. Receives the `level`, `message`, and merged `fields`. */
	protected abstract write(level: LogLevel, message: string, fields: LogFields): void;

	private mergeFields(fields?: LogFields): LogFields {
		const merged = fields ? { ...this.fields, ...fields } : this.fields;
		return this.redactSensitiveFields(merged);
	}

	/** Replaces the values of sensitive keys with `REDACTED_PLACEHOLDER`, but only when `options.redact` is enabled. */
	private redactSensitiveFields(fields: LogFields): LogFields {
		const { redact } = this.options;
		if (!redact) return fields;

		const patterns = (redact === true ? DEFAULT_REDACT_KEYS : redact).map((pattern) =>
			pattern.toLowerCase(),
		);
		const result: LogFields = {};
		for (const [key, value] of Object.entries(fields)) {
			const isSensitive = patterns.some((pattern) => key.toLowerCase().includes(pattern));
			result[key] = isSensitive ? REDACTED_PLACEHOLDER : value;
		}
		return result;
	}
}
