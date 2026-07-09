/**
 * Tests for `csvEscapeField`/`csvRow`/`csvDocument` (RFC4180-compliant CSV construction).
 */
import { describe, expect, test } from "vite-plus/test";
import { csvDocument, csvEscapeField, csvRow } from "../../src/helpers/csv.js";

/**
 * Leading characters that could be a formula-injection vector, excluding those that,
 * even after sanitization, still trigger RFC4180 quoting (comma, double quote, newline)
 * (`=` `+` `-` `@` tab). `\r` is verified separately since it still counts as a newline
 * and triggers RFC4180 quoting even after sanitization.
 */
const FORMULA_TRIGGER_CHARS_WITHOUT_CR = ["=", "+", "-", "@", "\t"] as const;

describe("csvEscapeField", () => {
	test("a value with no comma, quote, or newline is returned as-is", () => {
		expect(csvEscapeField("plain")).toBe("plain");
	});

	test("a value containing a comma is wrapped in double quotes", () => {
		expect(csvEscapeField("a,b")).toBe('"a,b"');
	});

	test("a value containing a double quote is doubled and then wrapped", () => {
		expect(csvEscapeField('say "hi"')).toBe('"say ""hi"""');
	});

	test("a value containing a newline (\\n only) is also wrapped", () => {
		expect(csvEscapeField("a\nb")).toBe('"a\nb"');
	});

	test("a value containing a newline (\\r only) is also wrapped", () => {
		expect(csvEscapeField("a\rb")).toBe('"a\rb"');
	});

	test.each(FORMULA_TRIGGER_CHARS_WITHOUT_CR)(
		"with formulaGuard on, a value starting with %s is sanitized by prefixing '",
		(trigger) => {
			expect(csvEscapeField(`${trigger}cmd`, { formulaGuard: true })).toBe(`'${trigger}cmd`);
		},
	);

	test("with formulaGuard on, a value starting with \\r (CR) is also subject to RFC4180 quoting after the ' prefix is added", () => {
		expect(csvEscapeField("\rcmd", { formulaGuard: true })).toBe('"\'\rcmd"');
	});

	test("with formulaGuard on, trigger characters that aren't leading are left untouched", () => {
		expect(csvEscapeField("a=b", { formulaGuard: true })).toBe("a=b");
	});

	test("with formulaGuard on, if the sanitized value still contains a comma etc., it is quoted as usual", () => {
		expect(csvEscapeField("=SUM(A1,A2)", { formulaGuard: true })).toBe('"\'=SUM(A1,A2)"');
	});

	test("without formulaGuard (default), formula trigger characters are left unchanged", () => {
		expect(csvEscapeField("=cmd")).toBe("=cmd");
	});
});

describe("csvRow", () => {
	test("escapes fields and joins them with commas", () => {
		expect(csvRow(["code", "a,b", 'say "hi"'])).toBe('code,"a,b","say ""hi"""');
	});

	test("with formulaGuard on, sanitizes each field before joining", () => {
		expect(csvRow(["code", "=cmd", "plain"], { formulaGuard: true })).toBe("code,'=cmd,plain");
	});

	test("without formulaGuard (default), fields are left unchanged", () => {
		expect(csvRow(["code", "=cmd"])).toBe("code,=cmd");
	});
});

describe("csvDocument", () => {
	test("joins rows with CRLF and doesn't append a trailing newline", () => {
		const doc = csvDocument([
			["code", "title"],
			["ABC-123", "はじめに"],
		]);

		expect(doc).toBe("code,title\r\nABC-123,はじめに");
	});

	test("with formulaGuard on, sanitizes the fields of every row", () => {
		const doc = csvDocument(
			[
				["code", "memo"],
				["ABC-123", "=SUM(A1)"],
			],
			{ formulaGuard: true },
		);

		expect(doc).toBe("code,memo\r\nABC-123,'=SUM(A1)");
	});

	test("without formulaGuard (default), it remains unchanged as before", () => {
		const doc = csvDocument([
			["code", "memo"],
			["ABC-123", "=SUM(A1)"],
		]);

		expect(doc).toBe("code,memo\r\nABC-123,=SUM(A1)");
	});
});
