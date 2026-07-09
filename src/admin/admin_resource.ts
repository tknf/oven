/**
 * Core abstraction for the unified admin panel (`AdminPanel`; `admin_panel.tsx`)'s
 * "resource CRUD" section. An app declares a Drizzle table + `Model` (`SQLiteModel`
 * etc.) together in a single `AdminResource` subclass. Wiring into the panel (route
 * generation, list/create/edit screens) happens in Step 3b (`admin_resource_view.tsx`
 * etc.), so no route or nav appears unless wired (Principle 4: "no magic").
 *
 * Same design decision as `admin_types.ts`: boundaries are kept loose and structural:
 * - Primary key is fixed to `string` (assumes a Snowflake text PK; number-PK tables
 *   are out of scope for admin v1)
 * - `AdminModel`'s return rows are `Record<string, unknown>`, input is `unknown`
 *   (real classes like `SQLiteModel`'s `create(input: Creatable)` etc. become
 *   assignable to an `AdminModel` accepting an `unknown` argument, due to method
 *   argument bivariance. This assignability is covered by Step 3b's real-class
 *   injection integration tests)
 */
import { getTableColumns, or, sql } from "drizzle-orm";
import type { Column, SQL, Table } from "drizzle-orm";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FieldDef, Form } from "../form/form.js";

/**
 * The structure `AdminResource#model` must satisfy. To avoid bringing the 3-dialect
 * differences of `Model` (`SQLiteModel`/`PgModel`/`MySqlModel`) in here, only the
 * shape of public methods is defined structurally (same convention as
 * `AdminJobsConsole` etc. in `admin_types.ts`).
 *
 * `create`/`update` receive validated values (successful `Form#validate` results)
 * as-is from `AdminPanel`'s wiring layer, so column allowlisting is not this type's
 * responsibility but the app's admin `Form#schema()`'s (the contract is that admin
 * does not use a schema that fails to strip unknown keys).
 */
export type AdminModel = {
	paginate(options: {
		cursor?: string;
		limit: number;
		direction?: "asc" | "desc";
		where?: SQL;
	}): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null; hasMore: boolean }>;
	retrieve(pk: string): Promise<Record<string, unknown> | undefined>;
	create(input: unknown): Promise<Record<string, unknown>>;
	update(pk: string, patch: unknown): Promise<Record<string, unknown> | undefined>;
	delete(pk: string): Promise<Record<string, unknown> | undefined>;
};

/**
 * One display column returned by `AdminResource#columns` (name = the property key
 * from `getTableColumns`, `column` = the Drizzle `Column` instance).
 */
export type AdminResourceColumn = { name: string; column: Column };

/**
 * Escapes LIKE pattern wildcard characters (`%`/`_`) and the escape character itself
 * (`\`). If `searchWhere` embedded user input as-is into `%${query}%`, a `query`
 * containing `%`/`_` could widen the match to an unintended scope (e.g. matching
 * everything). This is not about SQL injection, but preventing unintended widening
 * or narrowing of the search scope.
 */
const escapeLikePattern = (value: string): string =>
	value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * Abstract base class for declaring one resource (one table + one Model) in the
 * admin panel. Apps implement `key`/`label`/`model`/`table`/`primaryKey`, and
 * override `form` (view-only if unimplemented), `listColumns`, `exclude`, and
 * `searchColumns` as needed. Abstract getters and overridable hooks are prototype
 * methods (getters) for the same reason as `route_handler.ts`'s constraints
 * (subclasses implement them and they are not passed by reference).
 */
export abstract class AdminResource {
	/** URL slug (e.g. `"items"`). */
	abstract get key(): string;

	/** Resource name shown in nav and headings. */
	abstract get label(): string;

	/** The `Model` (structure satisfying `AdminModel`) this resource operates on. */
	abstract get model(): AdminModel;

	/** The Drizzle table inspected for display column metadata. */
	abstract get table(): Table;

	/** Column name to read the primary key value from a row (assumes a text PK). */
	abstract get primaryKey(): string;

	/**
	 * Create/edit form. If unimplemented (`undefined`), the resource becomes
	 * view-only and no create/edit/delete routes appear (Step 3b's wiring layer
	 * decides this via `canWrite()`).
	 */
	form?(): Form<StandardSchemaV1>;

	/** Explicit override of the list display columns (array of column names; order is also display order). Uses all columns in declaration order if omitted. */
	listColumns?(): string[];

	/** Column names to exclude from the list display. */
	exclude?(): string[];

	/** String column names to search. `searchWhere` is only active when specified. */
	searchColumns?(): string[];

	/**
	 * Resolves the display columns. Uses `listColumns()`'s order and names if
	 * present, otherwise all columns from `getTableColumns(table)` in declaration
	 * order. Either way, column names in `exclude()` are removed. If a nonexistent
	 * column name is included in `listColumns()`, throws to fail explicitly rather
	 * than silently omitting from the display (Principle 4).
	 */
	columns(): AdminResourceColumn[] {
		const tableColumns = getTableColumns(this.table);
		const excluded = new Set(this.exclude?.() ?? []);
		const names = this.listColumns?.() ?? Object.keys(tableColumns);

		return names
			.filter((name) => !excluded.has(name))
			.map((name) => {
				const column = tableColumns[name];
				if (!column) {
					throw new Error(
						`AdminResource "${this.key}": listColumns() specified a nonexistent column name "${name}"`,
					);
				}
				return { name, column };
			});
	}

	/**
	 * Builds `query` into an `OR`-combined `LIKE '%query%'` clause across each column
	 * in `searchColumns()`. Returns `undefined` (search disabled) if `searchColumns()`
	 * is empty or `query` is an empty string.
	 *
	 * Since `query` is user input that may contain LIKE wildcard characters (`%`/`_`)
	 * and the escape character itself (`\`), `escapeLikePattern` escapes them before
	 * wrapping with `%`. drizzle-orm's `like` helper does not emit an ESCAPE clause
	 * (confirmed in `node_modules/drizzle-orm/sql/expressions/conditions.js`; it only
	 * generates `column LIKE value`), so the `sql` tag explicitly adds `ESCAPE '\'`.
	 * The `ESCAPE` clause is interpreted with the same syntax (standard SQL) across
	 * SQLite/Postgres/MySQL, so no dialect branching is needed.
	 */
	searchWhere(query: string): SQL | undefined {
		const columnNames = this.searchColumns?.() ?? [];
		if (columnNames.length === 0 || query === "") return undefined;

		const tableColumns = getTableColumns(this.table);
		const pattern = `%${escapeLikePattern(query)}%`;
		const conditions = columnNames.map((name) => {
			const column = tableColumns[name];
			if (!column) {
				throw new Error(
					`AdminResource "${this.key}": searchColumns() specified a nonexistent column name "${name}"`,
				);
			}
			return sql`${column} like ${pattern} escape '\\'`;
		});
		return or(...conditions);
	}

	/** Whether create/edit/delete routes may appear (whether `form()` is implemented). */
	canWrite(): boolean {
		return typeof this.form === "function";
	}
}

/** Column names that `fieldsFromTable` excludes by default, as auto-managed columns. */
const DEFAULT_OMIT_COLUMN_NAMES: ReadonlySet<string> = new Set([
	"createdAt",
	"updatedAt",
	"lockVersion",
	"deletedAt",
]);

/** Derives the common part of a column (equivalent to `FieldDefBase`). */
const baseFieldFor = (column: Column): { label: string; required: boolean } => ({
	label: column.name,
	required: column.notNull,
});

/**
 * Builds a `FieldDef` for one non-overridden column, following the derivation
 * rules. Constructed via a per-widget union branch; no faking the union with `as`.
 */
const deriveFieldDef = (column: Column): FieldDef => {
	const base = baseFieldFor(column);

	if (Array.isArray(column.enumValues) && column.enumValues.length > 0) {
		return {
			...base,
			widget: "select",
			options: column.enumValues.map((value: string) => ({ value, label: value })),
		};
	}

	if (column.dataType === "boolean") {
		return { ...base, widget: "checkbox" };
	}

	if (column.dataType === "number" || column.dataType === "bigint") {
		return { ...base, widget: "input", type: "number" };
	}

	if (column.dataType === "date") {
		return { ...base, widget: "input", type: "datetime-local" };
	}

	return { ...base, widget: "input", type: "text" };
};

/**
 * Derives defaults for admin form `FieldDef`s from inspecting a Drizzle table
 * (`getTableColumns`). Intended to be spread into the app's admin `Form#fields()`
 * (individual overrides can also be written, e.g.
 * `{ ...fieldsFromTable(itemsTable), status: { label: "Status", ... } }`).
 *
 * - By default, columns with `column.primary` and columns named `createdAt`/
 *   `updatedAt`/`lockVersion`/`deletedAt` are not emitted (auto-managed columns
 *   should not be editable in the form). Column names in `options.omit` are also
 *   additionally excluded.
 * - If `options.overrides[columnName]` exists, its `FieldDef` is adopted as-is (a
 *   full replacement per column, not a partial merge — since `FieldDef` is a
 *   discriminated union, property-level merging would break the type), skipping
 *   derivation for that column. **Exclusion takes precedence**: default-excluded/
 *   `omit`-ted columns are not emitted even if they have overrides.
 */
export const fieldsFromTable = (
	table: Table,
	options?: { omit?: string[]; overrides?: Record<string, FieldDef> },
): Record<string, FieldDef> => {
	const omitted = new Set([...DEFAULT_OMIT_COLUMN_NAMES, ...(options?.omit ?? [])]);
	const overrides = options?.overrides ?? {};
	const tableColumns = getTableColumns(table);

	const result: Record<string, FieldDef> = {};
	for (const [name, column] of Object.entries(tableColumns)) {
		if (column.primary || omitted.has(name)) continue;
		result[name] = overrides[name] ?? deriveFieldDef(column);
	}
	return result;
};
