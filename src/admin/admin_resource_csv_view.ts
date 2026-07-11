/**
 * `AdminPanel`'s resource CRUD section's CSV export
 * (`GET /resources/<key>/export.csv`; `AdminPanel#wireResources`). Unlike the
 * other `admin_*_view.tsx` files (pure JSX components rendering the HTML
 * screens), this is a `View` subclass (`@tknf/oven/view`) that implements only
 * `csv()` — the route always wants the CSV representation, so it calls
 * `csv(c)` directly rather than going through `respond()`'s Accept
 * negotiation (see `docs/view.md`'s "call a single format method directly"
 * idiom). This is also the CSV helpers' (`@tknf/oven/helpers`'s
 * `csvDocument`) first internal use, dogfooding both per the design decision
 * in GitHub issue #29.
 */
import type { Context, Env } from "hono";
import { csvDocument } from "../helpers/csv.js";
import { View } from "../view/view.js";
import { stringifyCell } from "./stringify_cell.js";

export class AdminResourceCsvView<E extends Env = Env> extends View<E> {
	constructor(
		private readonly resourceKey: string,
		private readonly columnNames: string[],
		private readonly rows: Record<string, unknown>[],
	) {
		super();
	}

	/**
	 * Builds the CSV document — `columnNames` as the header row, then one row
	 * per `rows`, both stringified with `stringifyCell` so a cell (a boolean
	 * column included) always matches what the list screen shows for the same
	 * row — and returns it as a `text/csv` file download.
	 *
	 * `formulaGuard: true` is always on, not opt-in: this file is meant to be
	 * opened by an admin operator in a spreadsheet app (Excel, Google Sheets),
	 * so guarding against formula injection (OWASP CSV Injection) is the safe
	 * default for this specific export, per `csvDocument`'s own guidance on
	 * when to enable it.
	 */
	csv(c: Context<E>): Response {
		const table = [
			this.columnNames,
			...this.rows.map((row) => this.columnNames.map((name) => stringifyCell(row[name]))),
		];
		const document = csvDocument(table, { formulaGuard: true });

		return c.body(document, 200, {
			"Content-Type": "text/csv; charset=utf-8",
			"Content-Disposition": `attachment; filename="${this.resourceKey}.csv"`,
		});
	}
}
