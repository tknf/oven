/**
 * RFC4180-compliant CSV assembly helpers.
 *
 * Rules defined by RFC4180 that this module follows:
 * - Records (rows) are separated by CRLF.
 * - A field is only quoted with double quotes when it contains a comma,
 *   a double quote, or a newline (CRLF).
 * - A `"` inside a quoted field is doubled to `""`.
 * - A trailing newline after the last record is optional (this implementation
 *   does not add one, since `rows.map(csvRow).join(CRLF)` is sufficient on its own).
 *
 * The `formulaGuard` option mutates values (it prepends `'` to the affected field),
 * so it should only be used for CSV that a human opens in a spreadsheet app
 * (Excel, Google Sheets, etc.), never for CSV intended for machine-readable
 * consumption (e.g. integration with another system).
 */

/** CSV record separator (CRLF, as specified by RFC4180). */
const CRLF = "\r\n";

/**
 * Formula injection countermeasure (OWASP CSV Injection mitigation) for CSV data
 * that contains user input and may be opened in a spreadsheet app such as
 * Excel or Google Sheets.
 */
export type CsvOptions = {
	/**
	 * When `true`, a field starting with `=`, `+`, `-`, `@`, tab (`\t`), or CR (`\r`)
	 * is prefixed with a single quote `'` so it is not interpreted as a formula.
	 * The default (`false`/unset) matches the previous behavior exactly and never
	 * mutates values.
	 */
	formulaGuard?: boolean;
};

/** Leading characters that can trigger formula injection (`=` `+` `-` `@` tab `\r`). */
const FORMULA_TRIGGER_CHARS = /^[=+\-@\t\r]/;

/**
 * Escapes a single field per RFC4180. The field is only wrapped in double
 * quotes (with internal `"` doubled to `""`) when it contains a comma, a
 * double quote, or a newline (`\n`/`\r` — both components of CRLF are checked
 * so that data containing only a lone `\n` or `\r`, not just `\r\n`, is handled
 * safely). Values that don't need quoting are returned unchanged.
 *
 * When `options.formulaGuard` is `true` and the field starts with a formula
 * trigger character (`=` `+` `-` `@` tab `\r`), a `'` is prepended before the
 * escaping above is applied (once prepended, `'` itself has no special meaning
 * under RFC4180, so the field is quoted afterward only if it also contains a
 * comma etc., same as any ordinary value).
 */
export const csvEscapeField = (value: string, options?: CsvOptions): string => {
	const guarded = options?.formulaGuard && FORMULA_TRIGGER_CHARS.test(value) ? `'${value}` : value;

	if (!/[",\n\r]/.test(guarded)) {
		return guarded;
	}
	return `"${guarded.replaceAll('"', '""')}"`;
};

/** Escapes and joins a row's fields with commas (no trailing CRLF is added). */
export const csvRow = (fields: readonly string[], options?: CsvOptions): string =>
	fields.map((field) => csvEscapeField(field, options)).join(",");

/**
 * Assembles a full CSV document from an array of rows (each row being an
 * array of fields), including the header row. Rows are joined with CRLF and
 * no trailing newline is added (RFC4180 makes the trailing newline optional,
 * and this preserves the behavior of the original implementation, which did
 * not add one either).
 */
export const csvDocument = (rows: readonly (readonly string[])[], options?: CsvOptions): string =>
	rows.map((row) => csvRow(row, options)).join(CRLF);
