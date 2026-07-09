import { Logger, type LogFields, type LogLevel } from "./logger.js";

/**
 * `Logger` implementation that depends only on the `console` API. Each entry results in a single
 * `console` call, dispatching to `console.debug`/`console.info`/`console.warn`/`console.error`
 * according to the level.
 *
 * The output format passes a single plain object of the shape `{ level, message, ...fields }`
 * (fields are not stringified into the message). Passing a plain object directly to
 * `console.*`, as opposed to a `JSON.stringify`-ed string message, lets log platforms with
 * structured-logging support automatically extract and index the fields so they can be
 * filtered and searched individually. Cloudflare Workers Logs is one example of a platform
 * that documents this behavior (confirmed in the Workers Observability/Logs documentation on
 * `developers.cloudflare.com`, where this is documented as the recommended structured logging
 * format). This class itself is not Workers-specific and works the same way in any JS
 * environment where `console` is available (under Node, the runtime's own console
 * implementation formats the object for display).
 *
 * `level` and `message` are reserved keys: even if `fields` contains a key with the same name,
 * it is overridden by the level and message actually used by the logger itself.
 */
export class ConsoleLogger extends Logger {
	child(fields: LogFields): ConsoleLogger {
		return new ConsoleLogger({ ...this.fields, ...fields }, this.options);
	}

	protected write(level: LogLevel, message: string, fields: LogFields): void {
		const entry = { ...fields, level, message };

		switch (level) {
			case "debug":
				console.debug(entry);
				return;
			case "info":
				console.info(entry);
				return;
			case "warn":
				console.warn(entry);
				return;
			case "error":
				console.error(entry);
				return;
		}
	}
}
