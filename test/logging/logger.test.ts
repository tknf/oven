/**
 * Verifies `Logger` (the abstract base for structured loggers) and
 * `ConsoleLogger` (docs/testing.md L1). `Logger` is checked with a test stub
 * (a subclass that just records `write` calls) covering level-method-to-write
 * delegation, field merging, and `child` inheriting bound fields;
 * `ConsoleLogger` is checked by spying on `console` and verifying the output
 * shape.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { ConsoleLogger } from "../../src/logging/console_logger.js";
import { Logger, type LogFields, type LogLevel } from "../../src/logging/logger.js";

/** A test-only `Logger` stub that just records `write` calls. */
class RecordingLogger extends Logger {
	readonly writes: { level: LogLevel; message: string; fields: LogFields }[] = [];

	child(fields: LogFields): RecordingLogger {
		return new RecordingLogger({ ...this.fields, ...fields }, this.options);
	}

	protected write(level: LogLevel, message: string, fields: LogFields): void {
		this.writes.push({ level, message, fields });
	}
}

describe("Logger", () => {
	test("each level method delegates to write with the corresponding level", () => {
		const logger = new RecordingLogger();

		logger.debug("debug message");
		logger.info("info message");
		logger.warn("warn message");
		logger.error("error message");

		expect(logger.writes.map((entry) => entry.level)).toEqual(["debug", "info", "warn", "error"]);
	});

	test("merges bound fields with argument fields before passing to write", () => {
		const logger = new RecordingLogger({ service: "example" });

		logger.info("item created", { itemId: "123" });

		expect(logger.writes[0]?.fields).toEqual({ service: "example", itemId: "123" });
	});

	test("an argument field overwrites a bound field with the same key", () => {
		const logger = new RecordingLogger({ requestId: "bound" });

		logger.info("overwrite", { requestId: "override" });

		expect(logger.writes[0]?.fields).toEqual({ requestId: "override" });
	});

	test("child returns a new instance with merged bound fields", () => {
		const parent = new RecordingLogger({ service: "example" });

		const child = parent.child({ requestId: "req-1" });
		child.info("child log");

		expect(child).not.toBe(parent);
		expect(child.writes[0]?.fields).toEqual({ service: "example", requestId: "req-1" });
		expect(parent.writes).toHaveLength(0);
	});

	test("when redact is unset, fields are output as-is (unchanged behavior)", () => {
		const logger = new RecordingLogger();

		logger.info("login", { password: "s3cr3t", userId: "u1" });

		expect(logger.writes[0]?.fields).toEqual({ password: "s3cr3t", userId: "u1" });
	});

	test("redact: true masks the default sensitive keys (password/token/authorization/cookie, etc.)", () => {
		const logger = new RecordingLogger({}, { redact: true });

		logger.info("login", {
			password: "s3cr3t",
			accessToken: "tok-123",
			Authorization: "Bearer xyz",
			cookie: "session=abc",
			userId: "u1",
		});

		expect(logger.writes[0]?.fields).toEqual({
			password: "[REDACTED]",
			accessToken: "[REDACTED]",
			Authorization: "[REDACTED]",
			cookie: "[REDACTED]",
			userId: "u1",
		});
	});

	test("passing a string array to redact masks only matching key names (partial, case-insensitive)", () => {
		const logger = new RecordingLogger({}, { redact: ["secretKey"] });

		logger.info("event", { mySecretKeyValue: "hidden", userId: "u1" });

		expect(logger.writes[0]?.fields).toEqual({
			mySecretKeyValue: "[REDACTED]",
			userId: "u1",
		});
	});

	test("redact is also applied to bound fields", () => {
		const logger = new RecordingLogger({ password: "bound-secret" }, { redact: true });

		logger.info("event");

		expect(logger.writes[0]?.fields).toEqual({ password: "[REDACTED]" });
	});

	test("child inherits the redact setting", () => {
		const parent = new RecordingLogger({}, { redact: true });
		const child = parent.child({ token: "child-token" });

		child.info("event");

		expect(child.writes[0]?.fields).toEqual({ token: "[REDACTED]" });
	});
});

describe("ConsoleLogger", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("calls the console method matching the level, passing fields as structured data", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const logger = new ConsoleLogger({ service: "example" });
		logger.debug("debug message");
		logger.info("info message");
		logger.warn("warn message");
		logger.error("error message", { code: "E_TEST" });

		expect(debugSpy).toHaveBeenCalledWith({
			level: "debug",
			message: "debug message",
			service: "example",
		});
		expect(infoSpy).toHaveBeenCalledWith({
			level: "info",
			message: "info message",
			service: "example",
		});
		expect(warnSpy).toHaveBeenCalledWith({
			level: "warn",
			message: "warn message",
			service: "example",
		});
		expect(errorSpy).toHaveBeenCalledWith({
			level: "error",
			message: "error message",
			service: "example",
			code: "E_TEST",
		});
	});

	test("an instance obtained via child is still a ConsoleLogger and inherits bound fields", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

		const logger = new ConsoleLogger({ service: "example" });
		const child = logger.child({ requestId: "req-1" });
		child.info("child log");

		expect(child).toBeInstanceOf(ConsoleLogger);
		expect(infoSpy).toHaveBeenCalledWith({
			level: "info",
			message: "child log",
			service: "example",
			requestId: "req-1",
		});
	});

	test("passing level/message keys in fields does not override the logger's own values", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const logger = new ConsoleLogger();
		logger.error("real message", { level: "fake level", message: "fake message" });

		expect(errorSpy).toHaveBeenCalledWith({
			level: "error",
			message: "real message",
		});
	});
});
