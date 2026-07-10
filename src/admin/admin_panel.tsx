/**
 * Mount base for a unified admin panel, in oven's
 * explicit-registration style. Like `MailPreviewHandler`
 * (`src/mailer/mail_preview_handler.ts`), this is a `RouteHandler` subclass with
 * screens that an app explicitly mounts via `app.route("/admin", new AdminPanel({...}))`.
 * Whether to mount in production and SecureHeaders are the app's responsibility, but
 * the panel itself hard-codes an access gate as mandatory: `authorize`, or the
 * DB-backed permission gate derived from `accounts` (the constructor throws when
 * neither is injected). CSRF
 * verification (`csrf`; `Csrf` from `security/csrf.ts`) is enforced on write routes
 * **only when injected** (SEC-301: to lean toward a safe-by-default posture, a
 * warning-only is emitted on the first unsafe-method request when not injected).
 *
 * Job operations (`jobs`), settings (`settings`), audit log viewing (`audit`), and
 * resource CRUD (`resources`; `AdminResource` from `admin_resource.ts`) only render
 * and get routes **when their config is injected**.
 * There is no JS; operations are completed with native `<form method="post">` +
 * 303 See Other (when `csrf` is injected, each form embeds the token via a hidden
 * input). Since the app decides the mount base (e.g. `/admin`), internal
 * links/redirects are built by prefixing `AdminPanelOptions.basePath`
 * (default `"/admin"`) rather than using relative links.
 *
 * CSS is inlined into `<style>` by `AdminLayout` from `ADMIN_CSS` (a string constant
 * in `admin_styles.ts`), so this panel itself has no asset-serving route (keeps
 * runtime code fs-independent).
 *
 * Per `RouteHandler`'s constraint 2 (`src/routing/route_handler.ts`), `middleware()`/
 * `register()` are called during the base constructor (`super()`), so overrides must
 * be written as prototype methods. `register()` registers only the dashboard
 * (`GET "/"`); the job/settings/audit routes are registered additionally from
 * `wireSections()`, called after `super()` completes (after `panelOptions` is
 * assigned). Hono applies all middleware registered on an instance
 * (`this.use` via `middleware()`) to every matching route regardless of registration
 * order, so the authorization middleware also applies to section routes added later
 * (verified in `admin_panel.test.ts`). `panelOptions` itself is assigned once in the
 * constructor and immutable thereafter, but each handler follows the
 * `MailPreviewHandler` precedent and consistently references `this.panelOptions` at
 * request time (inside a closure).
 *
 * ## Persisting inline child rows
 * When a resource declares `inlines()` (`AdminInline` in `admin_resource.ts`), the
 * create/update handlers plan every submitted row (`planAllInlineRows`) and
 * validate the parent form **before writing anything**: if the parent or any
 * row fails, the whole request re-renders as 422 with nothing written, parent
 * or child (`buildInlineGroupsFromBody` rebuilds the inline groups straight
 * from the submitted body, since the DB hasn't changed). Only once everything
 * validates does the handler write the parent, then each inline row
 * (`persistInlineRows`) in declaration order. **This sequence is not
 * transactional** — `AdminModel` exposes no cross-table transaction primitive,
 * so a failure partway through child writes (e.g. a DB error on the third of
 * five child rows) can leave the parent and some children committed while
 * others are not. This is a deliberate scope limit of the fixed-row inline
 * editor, not an oversight; see `docs/admin.md`'s inline section for the
 * operator-facing note.
 */
import { and, eq, getTableColumns, gte, lt } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FormInput, FormInputValue, FormResult } from "../form/form.js";
import { RouteHandler } from "../routing/route_handler.js";
import type { Csrf } from "../security/csrf.js";
import type { Session } from "../session/session.js";
import { LastActiveSuperuserError } from "./admin_accounts_errors.js";
import { bindAdminT } from "./admin_catalog.js";
import type { AdminT } from "./admin_catalog.js";
import {
	ADMIN_BUILTIN_PERMISSIONS,
	resourcePermission,
	resourcePermissions,
} from "./admin_permissions.js";
import type { AdminInline, AdminResource } from "./admin_resource.js";
import { AdminAccountsGroupsDeleteView } from "./admin_accounts_groups_delete_view.js";
import { AdminAccountsGroupsFormView } from "./admin_accounts_groups_form_view.js";
import { AdminAccountsGroupsListView } from "./admin_accounts_groups_list_view.js";
import { AdminAccountsUsersDeleteView } from "./admin_accounts_users_delete_view.js";
import type { AdminAccountsCheckboxOption } from "./admin_accounts_users_form_view.js";
import { AdminAccountsUsersFormView } from "./admin_accounts_users_form_view.js";
import { AdminAccountsUsersListView } from "./admin_accounts_users_list_view.js";
import { AdminAuditView } from "./admin_audit_view.js";
import { AdminJobsView } from "./admin_jobs_view.js";
import type { AdminBreadcrumb, AdminNavItem } from "./admin_layout.js";
import { AdminLayout } from "./admin_layout.js";
import { AdminLoginView } from "./admin_login_view.js";
import { AdminResourceBulkDeleteView } from "./admin_resource_bulk_delete_view.js";
import { AdminResourceDeleteView } from "./admin_resource_delete_view.js";
import type { AdminInlineGroup, AdminInlineGroupRow } from "./admin_resource_form_view.js";
import { AdminResourceFormView } from "./admin_resource_form_view.js";
import { AdminResourceListView } from "./admin_resource_list_view.js";
import type {
	AdminDateHierarchyItem,
	AdminDateHierarchyNav,
	AdminResourceSort,
} from "./admin_resource_list_view.js";
import { AdminResourceShowView } from "./admin_resource_show_view.js";
import { AdminSettingsView } from "./admin_settings_view.js";
import type {
	AdminAccountsGroupRow,
	AdminAccountsGroups,
	AdminAccountsUserRow,
	AdminAccountsUsers,
	AdminAuditLog,
	AdminAuditRow,
	AdminFeatureFlags,
	AdminJobRow,
	AdminJobsConsole,
	AdminMaintenanceMode,
	AdminMessage,
	AdminUserTools,
} from "./admin_types.js";

/**
 * Reserved session flash key backing the success-message banner (SEC-301-style
 * reservation, mirroring `form.ts`'s `__oven_form_*__` keys so it can't collide
 * with the app's own session data).
 */
const ADMIN_MESSAGES_FLASH_KEY = "__oven_admin_messages__";

/**
 * Reserved session key holding the logged-in `AdminIdentity`, set by the built-in
 * `/login` route and read by the auth gate in `middleware()`. Same reservation
 * convention as `ADMIN_MESSAGES_FLASH_KEY`.
 */
const ADMIN_IDENTITY_SESSION_KEY = "__oven_admin_identity__";

/**
 * Sentinel `requiredPermission` returns for a route that only a superuser may
 * reach (the `accounts` section: operator-account management), bypassing the
 * granted-permission-set check entirely rather than requiring some specific
 * permission string a non-superuser could be granted. Distinct from `null`
 * (no permission required at all, open to every active operator).
 */
const SUPERUSER_ONLY = Symbol("AdminPanel superuser-only route");

/** Whether `value` has the shape of a single `AdminMessage`. */
const isAdminMessage = (value: unknown): value is AdminMessage =>
	typeof value === "object" &&
	value !== null &&
	"level" in value &&
	"text" in value &&
	(value.level === "success" || value.level === "error" || value.level === "info") &&
	typeof value.text === "string";

/** Whether `value` has the shape of an `AdminMessage[]`, as flashed by `AdminPanel#flashMessage`. */
const isAdminMessageArray = (value: unknown): value is AdminMessage[] =>
	Array.isArray(value) && value.every(isAdminMessage);

/** Whether `value` has the shape of an `AdminIdentity`, as stored by `AdminPanel#setIdentity`. */
const isAdminIdentity = (value: unknown): value is AdminIdentity => {
	if (typeof value !== "object" || value === null) return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if ("label" in value && value.label !== undefined && typeof value.label !== "string")
		return false;
	return true;
};

/** Number of items per page in the resource list. */
const PAGE_SIZE = 20;

/**
 * Parses the list screen's `?o=` sort query into a display column index +
 * direction, matching a familiar admin-console convention (`?o=<i>` ascending,
 * `?o=-<i>` descending; `i` indexes `AdminResource#columns()`, the same order
 * the list table's headers render in). Returns `null` for a missing,
 * non-numeric, or out-of-range value, so the caller falls back to its own
 * default order rather than passing a bogus column index to `listPage`.
 */
const parseSort = (raw: string | undefined, columnCount: number): AdminResourceSort => {
	if (!raw) return null;

	const direction = raw.startsWith("-") ? "desc" : "asc";
	const index = Number.parseInt(direction === "desc" ? raw.slice(1) : raw, 10);
	if (!Number.isInteger(index) || index < 0 || index >= columnCount) return null;

	return { index, direction };
};

/** Parses the list screen's `?p=` page query (0-based). Clamps anything invalid or negative to `0`. */
const parsePage = (raw: string | undefined): number => {
	const page = Number.parseInt(raw ?? "0", 10);
	return Number.isInteger(page) && page > 0 ? page : 0;
};

/**
 * Combines zero or more optional `WHERE` clauses with `AND`, skipping the
 * `undefined` ones. Returns `undefined` when nothing remains (no narrowing),
 * the single clause unwrapped when only one remains, or an `and(...)` of
 * every remaining clause otherwise.
 */
const combineWhere = (...conditions: (SQL | undefined)[]): SQL | undefined => {
	const defined = conditions.filter((value): value is SQL => value !== undefined);
	if (defined.length === 0) return undefined;
	return defined.length === 1 ? defined[0] : and(...defined);
};

/**
 * The list screen's `?dhy=`/`?dhm=`/`?dhd=` drilldown query, parsed down to
 * the deepest **valid** level: an out-of-range or non-numeric deeper value is
 * dropped rather than rejecting the whole query (e.g. a valid year with a
 * bogus month yields `{ year }`, not `{}`).
 */
type DateHierarchyQuery = { year?: number; month?: number; day?: number };

/** Number of days in `year`-`month` (1-based month), via `Date.UTC`'s day-0-of-next-month trick. */
const daysInMonth = (year: number, month: number): number =>
	new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Parses the list screen's date-hierarchy drilldown query from its raw `?dhy=`/`?dhm=`/`?dhd=` string values. */
const parseDateHierarchyQuery = (
	rawYear: string | undefined,
	rawMonth: string | undefined,
	rawDay: string | undefined,
): DateHierarchyQuery => {
	const year = Number.parseInt(rawYear ?? "", 10);
	if (!Number.isInteger(year)) return {};

	const month = Number.parseInt(rawMonth ?? "", 10);
	if (!Number.isInteger(month) || month < 1 || month > 12) return { year };

	const day = Number.parseInt(rawDay ?? "", 10);
	if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return { year, month };

	return { year, month, day };
};

/**
 * Builds the `WHERE` clause narrowing `column` (an integer epoch-millisecond
 * date column) to the period described by `query` (inclusive start,
 * exclusive end, UTC calendar). `undefined` when no year is selected (no
 * narrowing at all).
 */
const dateHierarchyPeriodWhere = (column: Column, query: DateHierarchyQuery): SQL | undefined => {
	const { year, month, day } = query;
	if (year === undefined) return undefined;

	if (month === undefined) {
		return and(gte(column, Date.UTC(year, 0, 1)), lt(column, Date.UTC(year + 1, 0, 1)));
	}
	if (day === undefined) {
		return and(gte(column, Date.UTC(year, month - 1, 1)), lt(column, Date.UTC(year, month, 1)));
	}
	return and(
		gte(column, Date.UTC(year, month - 1, day)),
		lt(column, Date.UTC(year, month - 1, day + 1)),
	);
};

/**
 * Builds one date-hierarchy nav link: preserves the current search `query`
 * and `activeFilters`, sets `?dhy=`/`?dhm=`/`?dhd=` from `dh`, and always
 * resets pagination (`?p=` is dropped), same "changing scope returns to page
 * 0" convention as `buildListUrl` in `admin_resource_list_view.tsx`. Passing
 * an empty `dh` clears every `dh*` param (the "back to all periods" link).
 */
const buildDateHierarchyHref = (
	basePath: string,
	resourceKey: string,
	query: string,
	activeFilters: Record<string, string | undefined>,
	dh: DateHierarchyQuery,
): string => {
	const params = new URLSearchParams();
	if (query) params.set("q", query);
	for (const [column, value] of Object.entries(activeFilters)) {
		if (value) params.set(column, value);
	}
	if (dh.year !== undefined) params.set("dhy", String(dh.year));
	if (dh.month !== undefined) params.set("dhm", String(dh.month));
	if (dh.day !== undefined) params.set("dhd", String(dh.day));

	const qs = params.toString();
	const base = `${basePath}/resources/${resourceKey}`;
	return qs ? `${base}?${qs}` : base;
};

/** Localized long month name for `year`-`month` (1-based), via `Intl.DateTimeFormat`. */
const dateHierarchyMonthLabel = (lang: string, year: number, month: number): string =>
	new Intl.DateTimeFormat(lang, { month: "long", timeZone: "UTC" }).format(
		new Date(Date.UTC(year, month - 1, 1)),
	);

/**
 * Builds the list screen's date-hierarchy nav (`AdminDateHierarchyNav`) one
 * level at a time (year -> month -> day), following how far `dhQuery` has
 * drilled down. `baseWhere` is the search/filter `WHERE` clause **without**
 * the date period narrowing, so the enumerated years/months/days reflect the
 * full search/filter scope rather than just the currently selected period.
 *
 * `dhColumn`'s min/max value is found via two `AdminModel#listPage` calls
 * (`orderBy`+`limit: 1`, ascending and descending) rather than a dedicated
 * aggregation query (no new `AdminModel` method is introduced for this).
 * Every year/month/day between min and max is enumerated, not only periods
 * that actually contain rows — a deliberate simplification documented on
 * `AdminResource#dateHierarchy`; a selected period can render an empty list.
 * Returns `undefined` when there is no row to anchor min/max on.
 */
const buildDateHierarchyNav = async (
	target: AdminResource,
	dhColumnName: string,
	dhColumn: Column,
	baseWhere: SQL | undefined,
	dhQuery: DateHierarchyQuery,
	basePath: string,
	resourceKey: string,
	searchQuery: string,
	activeFilters: Record<string, string | undefined>,
	lang: string,
	t: AdminT,
): Promise<AdminDateHierarchyNav | undefined> => {
	const [[earliest], [latest]] = await Promise.all([
		target.model.listPage({
			where: baseWhere,
			orderBy: [{ column: dhColumn, direction: "asc" }],
			limit: 1,
		}),
		target.model.listPage({
			where: baseWhere,
			orderBy: [{ column: dhColumn, direction: "desc" }],
			limit: 1,
		}),
	]);
	if (!earliest || !latest) return undefined;

	const minMs = Number(earliest[dhColumnName]);
	const maxMs = Number(latest[dhColumnName]);
	if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return undefined;

	const href = (dh: DateHierarchyQuery) =>
		buildDateHierarchyHref(basePath, resourceKey, searchQuery, activeFilters, dh);

	if (dhQuery.year === undefined) {
		const minYear = new Date(minMs).getUTCFullYear();
		const maxYear = new Date(maxMs).getUTCFullYear();
		const items: AdminDateHierarchyItem[] = [];
		for (let year = minYear; year <= maxYear; year++) {
			items.push({ label: String(year), href: href({ year }) });
		}
		return { items };
	}

	const { year } = dhQuery;
	if (dhQuery.month === undefined) {
		const items: AdminDateHierarchyItem[] = [];
		for (let month = 1; month <= 12; month++) {
			items.push({
				label: dateHierarchyMonthLabel(lang, year, month),
				href: href({ year, month }),
			});
		}
		return { back: { label: t("dateHierarchy.all"), href: href({}) }, items };
	}

	const { month } = dhQuery;
	if (dhQuery.day === undefined) {
		const items: AdminDateHierarchyItem[] = [];
		for (let day = 1; day <= daysInMonth(year, month); day++) {
			items.push({ label: String(day), href: href({ year, month, day }) });
		}
		return { back: { label: String(year), href: href({ year }) }, items };
	}

	return {
		back: { label: dateHierarchyMonthLabel(lang, year, month), href: href({ year, month }) },
		items: [],
		current: String(dhQuery.day),
	};
};

/**
 * Returns a shallow copy of `value` with `key` removed, if `value` is an object.
 * Non-objects are returned as-is. Used by the update handler so that, even if a
 * primary key column ends up in the validated value, the row's identity (the `id`
 * from the URL) is not overwritten (because `SQLiteModel#update` etc. unconditionally
 * `.set()`s `patch`).
 */
const withoutKey = (value: unknown, key: string): unknown => {
	if (typeof value !== "object" || value === null) return value;
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (k !== key) rest[k] = v;
	}
	return rest;
};

/**
 * Converts an unknown value to a string. Since `String(unknown)` can produce
 * `"[object Object]"` when passed an object (as the lint rule `no-base-to-string`
 * flags), only string/number/bigint are converted; anything else (object,
 * undefined, etc.) becomes an empty string.
 */
const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	return "";
};

/**
 * Prepends `${prefix}-` to every key of `input`. `Form#bind({ prefix, values })`
 * looks up `values` by the already-prefixed key (matching how the browser
 * submits a prefixed form; see `form.ts`'s "prefix round trip" JSDoc), but
 * `Form#toInput(row)` returns raw (unprefixed) keys, so an inline row's
 * prefilled values must be re-keyed through this before being passed to `bind`.
 */
const prefixFormInput = (input: FormInput, prefix: string): FormInput =>
	Object.fromEntries(Object.entries(input).map(([key, value]) => [`${prefix}-${key}`, value]));

/**
 * Builds the `AdminInlineGroup[]` (`admin_resource_form_view.tsx`) for `target`'s
 * create/edit form, one group per `target.inlines()` entry. Passing `parentId`
 * (the edit form's row id) fetches the existing children via
 * `inline.model.listPage`, matched against `inline.foreignKey`, and renders one
 * bound row per child ahead of `inline.extra` (default `3`) blank rows; omitting
 * it (the new form, where there is no parent row yet) renders only blank rows.
 * Row field-name prefixes (`${key}-${index}`) and the `__pk`/`__total` markers
 * follow the convention documented on `AdminInline` — kept in lockstep with it
 * since a later step's submission handler depends on this exact naming.
 */
const buildInlineGroups = async (
	target: AdminResource,
	parentId?: string,
): Promise<AdminInlineGroup[]> => {
	const inlines = target.inlines?.() ?? [];
	const groups: AdminInlineGroup[] = [];

	for (const inline of inlines) {
		const extra = inline.extra ?? 3;
		const foreignKeyColumn = getTableColumns(inline.table)[inline.foreignKey];
		if (!foreignKeyColumn) {
			throw new Error(
				`AdminResource "${target.key}": inlines() inline "${inline.key}" specified a nonexistent foreignKey column "${inline.foreignKey}"`,
			);
		}

		const children =
			parentId !== undefined
				? await inline.model.listPage({ where: eq(foreignKeyColumn, parentId), limit: 200 })
				: [];

		const rows: AdminInlineGroupRow[] = children.map((child, index) => {
			const prefix = `${inline.key}-${index}`;
			return {
				index,
				binding: inline
					.form()
					.bind({ prefix, values: prefixFormInput(inline.form().toInput(child), prefix) }),
				pk: stringify(child[inline.primaryKey]),
			};
		});
		for (let index = children.length; index < children.length + extra; index++) {
			rows.push({ index, binding: inline.form().bind({ prefix: `${inline.key}-${index}` }) });
		}

		groups.push({
			key: inline.key,
			label: inline.label,
			headers: inline
				.form()
				.bind()
				.visibleFields()
				.map((field) => field.label),
			rows,
			total: children.length + extra,
		});
	}

	return groups;
};

/**
 * Plan for one submitted inline row (`admin_panel.tsx`'s inline submission
 * handling; see the module JSDoc "Persisting inline child rows"). Built by
 * `planInlineRows` ahead of any write, so the parent write only happens once
 * every row (across every inline) is known to be either skippable, a
 * deletion, or a successful validation.
 */
type InlineRowPlan = {
	/** 0-based row index within this inline, matching `${key}-${index}-*` field names. */
	index: number;
	/** The row's `${key}-${index}-__pk` value. Empty string for a not-yet-persisted row. */
	pk: string;
	/** Whether `${key}-${index}-__delete` was checked. */
	del: boolean;
	/** A wholly blank extra row (no pk, no field filled in) — not validated, created, updated, or deleted. */
	skip: boolean;
	/**
	 * The row's own `Form#validate` result. `null` when `skip` is `true` or when
	 * the row is a deletion of an existing row (`del && pk !== ""`), neither of
	 * which requires validation.
	 */
	result: FormResult<unknown> | null;
};

/**
 * Whether `body` has at least one non-empty field value under the row prefix
 * `${prefix}-` (excluding the `__pk`/`__delete` markers). Used by
 * `planInlineRows` to distinguish an untouched extra blank row (which must not
 * be validated or created) from a row the operator actually filled in.
 */
const hasNonEmptyRowValue = (body: FormInput, prefix: string): boolean => {
	const marker = `${prefix}-`;
	for (const [fieldKey, value] of Object.entries(body)) {
		if (!fieldKey.startsWith(marker)) continue;
		if (fieldKey === `${marker}__pk` || fieldKey === `${marker}__delete`) continue;
		if (typeof value === "string" && value !== "") return true;
		if (Array.isArray(value) && value.some((item) => typeof item === "string" && item !== "")) {
			return true;
		}
	}
	return false;
};

/** Parses an inline group's `${key}-__total` hidden field. Clamps anything missing, non-numeric, or negative to `0`. */
const parseInlineTotal = (raw: FormInputValue): number => {
	const total = Number.parseInt(stringify(raw), 10);
	return Number.isInteger(total) && total > 0 ? total : 0;
};

/**
 * Plans every row of one submitted `AdminInline`, up to its `${key}-__total`
 * count, following the fixed decision order documented on `InlineRowPlan`:
 * a wholly blank row is skipped before anything else is checked, then a
 * checked delete on an existing row is marked without validating, and every
 * remaining row (an existing row's edit, or a filled-in new row) is validated
 * through the child `Form`.
 */
const planInlineRows = async (inline: AdminInline, body: FormInput): Promise<InlineRowPlan[]> => {
	const total = parseInlineTotal(body[`${inline.key}-__total`]);
	const rows: InlineRowPlan[] = [];

	for (let index = 0; index < total; index++) {
		const prefix = `${inline.key}-${index}`;
		const pk = stringify(body[`${prefix}-__pk`] ?? "");
		const del = body[`${prefix}-__delete`] !== undefined;

		if (pk === "" && !hasNonEmptyRowValue(body, prefix)) {
			rows.push({ index, pk, del, skip: true, result: null });
			continue;
		}
		if (del && pk !== "") {
			rows.push({ index, pk, del, skip: false, result: null });
			continue;
		}

		const result = await inline.form().validate(body, { prefix });
		rows.push({ index, pk, del, skip: false, result });
	}

	return rows;
};

/** Plans every inline row of every `target.inlines()` entry, keyed by `AdminInline#key`. */
const planAllInlineRows = async (
	target: AdminResource,
	body: FormInput,
): Promise<Map<string, InlineRowPlan[]>> => {
	const plans = new Map<string, InlineRowPlan[]>();
	for (const inline of target.inlines?.() ?? []) {
		plans.set(inline.key, await planInlineRows(inline, body));
	}
	return plans;
};

/** Whether `row` requires no write-blocking action: it's skippable, a validation-free deletion, or a successful validation. */
const inlineRowIsValid = (row: InlineRowPlan): boolean =>
	row.skip || (row.del && row.pk !== "") || (row.result?.ok ?? false);

/** Whether every planned row across every inline in `plans` is valid (see `inlineRowIsValid`). */
const allInlineRowsValid = (plans: Map<string, InlineRowPlan[]>): boolean =>
	[...plans.values()].every((rows) => rows.every(inlineRowIsValid));

/**
 * Rebuilds `AdminInlineGroup[]` for a 422 re-render, straight from the
 * submitted `body` and its `plans` (`planAllInlineRows`) rather than from the
 * DB (the write hasn't happened yet). `values: body` works as-is because
 * `body`'s keys are already prefixed with `${key}-${index}-` (the exact shape
 * `Form#bind({ prefix, values })` expects), unlike `buildInlineGroups`'s
 * DB-sourced rows which need `prefixFormInput` first.
 */
const buildInlineGroupsFromBody = (
	target: AdminResource,
	body: FormInput,
	plans: Map<string, InlineRowPlan[]>,
): AdminInlineGroup[] => {
	const groups: AdminInlineGroup[] = [];

	for (const inline of target.inlines?.() ?? []) {
		const rows = plans.get(inline.key) ?? [];
		groups.push({
			key: inline.key,
			label: inline.label,
			headers: inline
				.form()
				.bind()
				.visibleFields()
				.map((field) => field.label),
			rows: rows.map((row) => {
				const prefix = `${inline.key}-${row.index}`;
				const errors = row.result && !row.result.ok ? row.result.errors : [];
				return {
					index: row.index,
					binding: inline.form().bind({ prefix, errors, values: body }),
					pk: row.pk !== "" ? row.pk : undefined,
				};
			}),
			total: rows.length,
		});
	}

	return groups;
};

/**
 * Returns a shallow copy of `value` with `foreignKey` set to `parentId`, if
 * `value` is an object. Used to attach a newly-created inline child row to its
 * just-created-or-existing parent (the child `Form#schema()` never includes
 * the foreign key column itself, since `fieldsFromTable` derives fields from
 * non-primary-key columns but a foreign key is the app's own field list to
 * manage — see `AdminInline#form`'s JSDoc).
 */
const withForeignKey = (value: unknown, foreignKey: string, parentId: string): unknown => {
	if (typeof value !== "object" || value === null) return value;
	return { ...value, [foreignKey]: parentId };
};

/**
 * Persists every planned inline row (`planAllInlineRows`) against `parentId`,
 * one `AdminModel` call per row, in declaration order — sequentially, not in
 * a transaction (see the module JSDoc "Persisting inline child rows": admin
 * has no cross-table transaction primitive to use here). Only called once the
 * caller has confirmed `allInlineRowsValid(plans)`, so `!row.result.ok` is not
 * expected to occur; such a row is defensively skipped rather than persisted
 * with unvalidated data.
 */
const persistInlineRows = async (
	target: AdminResource,
	plans: Map<string, InlineRowPlan[]>,
	parentId: string,
): Promise<void> => {
	for (const inline of target.inlines?.() ?? []) {
		for (const row of plans.get(inline.key) ?? []) {
			if (row.skip) continue;
			if (row.del && row.pk !== "") {
				await inline.model.delete(row.pk);
				continue;
			}
			if (!row.result || !row.result.ok) continue;

			if (row.pk !== "") {
				await inline.model.update(row.pk, row.result.value);
			} else {
				await inline.model.create(withForeignKey(row.result.value, inline.foreignKey, parentId));
			}
		}
	}
};

/**
 * Normalizes a `FormInput` field that may be absent, a single value, or an array
 * (however many checkboxes of a same-named group were checked) into a
 * `string[]`. A `File` entry can never legitimately appear in a checkbox-group
 * field, so it is dropped rather than stringified.
 */
const multiValueField = (body: FormInput, name: string): string[] => {
	const raw = body[name];
	const values = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
	return values.filter((value): value is string => typeof value === "string");
};

/** Normalizes `body._selected_action` (the list screen's bulk-action row-selection checkboxes) via `multiValueField`. */
const selectedActionIds = (body: FormInput): string[] => multiValueField(body, "_selected_action");

/** Reads a single-value `FormInput` field as a string, or `""` when absent, a `File`, or an array. */
const stringFormField = (body: FormInput, name: string): string => {
	const value = body[name];
	return typeof value === "string" ? value : "";
};

/**
 * Normalizes the loosely-typed return of `AdminJobsConsole#listPending`/`listFailed`
 * (`Record<string, unknown>[]`; the real class is loosely typed via `AnySQLiteColumn`)
 * into a display-ready `AdminJobRow`. Since drizzle's `.select()` returns JS property
 * names (camelCase), it is referenced via `runAt`/`failedAt`/`lastError`.
 */
const toJobRow = (row: Record<string, unknown>): AdminJobRow => ({
	id: stringify(row.id),
	name: stringify(row.name),
	priority: Number(row.priority ?? 0),
	runAt: Number(row.runAt ?? 0),
	attempts: Number(row.attempts ?? 0),
	failedAt: row.failedAt == null ? null : Number(row.failedAt),
	lastError: row.lastError == null ? null : stringify(row.lastError),
});

/**
 * Normalizes the loosely-typed return of `AdminAuditLog#list`
 * (`Record<string, unknown>[]`) into a display-ready `AdminAuditRow`. Same reason
 * and same convention as `toJobRow`.
 */
const toAuditRow = (row: Record<string, unknown>): AdminAuditRow => ({
	id: stringify(row.id),
	actor: stringify(row.actor),
	action: stringify(row.action),
	target: stringify(row.target),
	changes: row.changes == null ? null : stringify(row.changes),
	createdAt: Number(row.createdAt ?? 0),
});

/**
 * Every permission an accounts management UI may grant to a user or group:
 * the built-in non-resource permissions (`ADMIN_BUILTIN_PERMISSIONS`) plus
 * each wired resource's four action permissions (`resourcePermissions`). This
 * is deliberately the same enumeration a resource's own permission gate
 * checks against (`requiredPermission`), so a permission granted through the
 * accounts screen is guaranteed to be one the gate can actually match.
 */
const knownAccountPermissions = (resources: AdminResource[]): string[] => {
	const permissions: string[] = [...ADMIN_BUILTIN_PERMISSIONS];
	for (const resource of resources) permissions.push(...resourcePermissions(resource.key));
	return permissions;
};

/**
 * Merges a user's or group's submitted permission checkboxes with its
 * previously-stored permission strings, for the accounts users/groups
 * create and update handlers (`wireAccounts`/`wireAccountsGroups`).
 * `submitted` is filtered down to `known` (a checkbox can only ever submit a
 * value that was rendered, but the body is untrusted input all the same);
 * `stored` entries absent from `known` (e.g. granted by an app no longer
 * wiring that resource) are preserved as `retainedUnknown` so saving the form
 * never silently drops a permission it has no checkbox to represent.
 * `nextPermissions` — the checked and retained-unknown permissions combined,
 * de-duplicated — is what a create/update handler writes back; a create
 * handler (no prior row) calls this with `stored: []`, so `retainedUnknown` is
 * always `[]` and `nextPermissions` is just the de-duplicated checked set.
 */
const mergePermissionSelection = (
	known: string[],
	stored: string[],
	submitted: string[],
): { checkedPermissions: string[]; retainedUnknown: string[]; nextPermissions: string[] } => {
	const knownSet = new Set(known);
	const checkedPermissions = submitted.filter((permission) => knownSet.has(permission));
	const retainedUnknown = stored.filter((permission) => !knownSet.has(permission));
	const nextPermissions = [...new Set([...checkedPermissions, ...retainedUnknown])];
	return { checkedPermissions, retainedUnknown, nextPermissions };
};

/** Builds one checkbox option per `known` permission string, checked according to `checked`. */
const buildPermissionOptions = (
	known: string[],
	checked: ReadonlySet<string>,
): AdminAccountsCheckboxOption[] =>
	known.map((permission) => ({
		value: permission,
		label: permission,
		checked: checked.has(permission),
	}));

/** Builds one checkbox option per group row, checked according to `memberOf` (a set of group ids). */
const buildGroupOptions = (
	groups: AdminAccountsGroupRow[],
	memberOf: ReadonlySet<string>,
): AdminAccountsCheckboxOption[] =>
	groups.map((group) => ({ value: group.id, label: group.name, checked: memberOf.has(group.id) }));

/**
 * Fetches one group row by id, via `listGroups().find(...)` rather than a
 * dedicated retrieve method: `AdminAccountsGroups` (`admin_types.ts`)
 * deliberately exposes no single-group lookup, since the groups management
 * screen expects a small enough group count that scanning the full list is
 * acceptable.
 */
const findGroup = async (
	groups: AdminAccountsGroups,
	id: string,
): Promise<AdminAccountsGroupRow | undefined> => {
	const rows = await groups.listGroups();
	return rows.find((row) => row.id === id);
};

/**
 * The logged-in operator's identity, as returned by `AdminPanelOptions.auth.authenticate`
 * and held in the session between requests. Deliberately minimal — admin does not
 * assume the app's user table shape (role, permissions, etc. stay the app's own
 * concern, read back via `session` from within `authorize`).
 */
export type AdminIdentity = {
	id: string;
	label?: string;
};

export type AdminPanelOptions<E extends Env = Env> = {
	/**
	 * Admin access authorization callback. Required unless `accounts` is injected
	 * (the built-in permission gate takes over then); when both are given, this
	 * runs IN ADDITION to the accounts gate (both must allow — an AND). Assumes
	 * reuse of the existing `Guard`/`Policy`; the core does not assume an
	 * admin-only role (e.g. `authorize: (c) => adminPolicy.canAccess(c.get("user"))`).
	 */
	authorize?: (c: Context<E>) => boolean | Promise<boolean>;
	/** Brand name shown in the screen header/title. Default `"Admin"`. */
	brand?: string;
	/** Response status when `authorize` returns `false`. Default `403`. */
	denyStatus?: ContentfulStatusCode;
	/** This panel's mount base path. Default `"/admin"`. Used to prefix internal links/redirects. */
	basePath?: string;
	/**
	 * CSRF verification (`Csrf` from `security/csrf.ts`). When injected, `csrf.verify`
	 * applies to all write routes (`SAFE_METHODS` self-skip), and each form embeds a
	 * hidden input derived from `csrf.csrfToken(c)`. When not injected, neither
	 * verification nor the hidden input is emitted, as before (backward compatible),
	 * but a one-time warning is issued on the first unsafe-method request (SEC-301).
	 */
	csrf?: Csrf<E>;
	/** Job operations screen. No rendering or routes if not injected. */
	jobs?: { console: AdminJobsConsole };
	/** Settings screen (feature flags/maintenance mode). Each section may be omitted independently. */
	settings?: {
		featureFlags?: { flags: AdminFeatureFlags; names: string[] };
		maintenance?: AdminMaintenanceMode;
	};
	/**
	 * Audit log viewing screen. If `actor` is not specified, the recorded actor
	 * defaults to the logged-in identity's label (falling back to its id), and to
	 * `"admin"` when there is no auth wiring or no logged-in identity (see
	 * `recordAudit`).
	 */
	audit?: { log: AdminAuditLog; actor?: (c: Context<E>) => string | Promise<string> };
	/** Resource CRUD screen (`AdminResource` from `admin_resource.ts`). No rendering or routes if not injected. */
	resources?: AdminResource[];
	/**
	 * Session accessor (e.g. `SessionAccessor#use`), injected the same optional way as
	 * `csrf`/`audit`. When injected, resource create/update success flashes a
	 * `message.added`/`message.changed` banner, shown once on the next GET (consume-once,
	 * same as `Session#flash`). When not injected, no banner is ever shown (backward
	 * compatible).
	 */
	session?: (c: Context<E>) => Session;
	/**
	 * Header user-tools block (`#user-tools`: a greeting plus links such as
	 * "View site" / "Log out"), injected the same optional way
	 * as `csrf`/`audit`/`session`. Authentication/session details are the
	 * app's responsibility, not admin's, so the app builds the greeting text
	 * and link list itself from `Context`. When not injected, no user-tools
	 * block is rendered (backward compatible).
	 */
	userTools?: (c: Context<E>) => AdminUserTools;
	/**
	 * Built-in login/logout screens and session wiring (`GET`/`POST "/login"`,
	 * `POST "/logout"`), injected the same optional way as `csrf`/`audit`/`session`.
	 * Admin does not assume the app's user table shape — credential verification is
	 * entirely the app's own `authenticate` callback (e.g. looking up a row and
	 * checking it with `verifyPassword` from `@tknf/oven/auth`); admin only wires the
	 * screens, the session-backed identity, and the auth gate that redirects an
	 * unauthenticated request to `/login`. Requires `session` to also be injected
	 * (enforced by the constructor); without it there is nowhere to hold the
	 * logged-in identity between requests. When neither this nor `accounts` is
	 * injected, there are no login/logout routes and no auth gate — every route is
	 * guarded by `authorize` alone, exactly as before (backward compatible). When
	 * `accounts` is injected, omitting this derives the screens from the accounts
	 * service; injecting it explicitly overrides the derived wiring (see
	 * `effectiveAuth` — the returned identity's `id` must then be an accounts
	 * user id).
	 */
	auth?: {
		authenticate: (
			c: Context<E>,
			credentials: { username: string; password: string },
		) => Promise<AdminIdentity | null>;
	};
	/**
	 * DB-backed operator accounts (`SQLiteAdminAccounts` etc., via the structural
	 * contracts in `admin_types.ts`). Injecting this: (a) derives the built-in
	 * login/logout (`auth`) from the users service when `auth` is not given,
	 * (b) makes `authorize` optional — a built-in permission gate takes over,
	 * resolving the required permission per route (`requiredPermission`, using the
	 * `admin_permissions.ts` vocabulary) and checking it against the operator's
	 * granted set, (c) requires both `session` and `csrf` (the constructor throws
	 * otherwise), (d) re-validates the logged-in operator against the DB on every
	 * request, so setting `isActive: false` or deleting the row revokes access
	 * immediately, and (e) lets superusers bypass all permission checks. When
	 * `groups` is injected too, the granted set is the union of the user's own
	 * permission set and every group's set (`permissionsForUser`).
	 */
	accounts?: {
		users: AdminAccountsUsers;
		groups?: AdminAccountsGroups;
	};
};

/** `RouteHandler` subclass that serves the unified admin panel, mounted explicitly by the app. */
export class AdminPanel<E extends Env = Env> extends RouteHandler<E> {
	/**
	 * `options` collides with Hono's reserved instance member name (used for HTTP
	 * OPTIONS method registration; see `route_handler.ts` constraint 1), so the field
	 * is named `panelOptions` instead.
	 */
	private panelOptions: AdminPanelOptions<E> | undefined;

	/**
	 * Becomes `true` once an unsafe-method request has been received with `csrf` not
	 * injected (used by `warnCsrfMissingOnce` to prevent duplicate warnings).
	 */
	private csrfMissingWarned = false;

	/**
	 * The current request's re-validated operator row (`accounts.users.retrieve`)
	 * plus its granted permission set, keyed by the underlying `Request` object
	 * so views rendered later in the same request (namely `buildNav`'s
	 * superuser-only Accounts link and its per-section permission filter) can
	 * read them without threading them through every call site. Set in
	 * `middleware()` right after the row is re-validated; never set for a
	 * request with no `accounts` option or no logged-in identity.
	 *
	 * `granted` is `null` for a superuser (whose bypass makes a granted set
	 * meaningless) and is otherwise always populated — non-superusers need it
	 * both for the permission gate below and for `buildNav`'s filter, so it is
	 * fetched once per request regardless of which route was hit.
	 */
	private readonly requestOperator = new WeakMap<
		Request,
		{ row: AdminAccountsUserRow; granted: ReadonlySet<string> | null }
	>();

	constructor(options: AdminPanelOptions<E>) {
		super();
		this.panelOptions = options;
		if (!options.authorize && !options.accounts) {
			throw new Error(
				"AdminPanel: either `authorize` or `accounts` must be injected (the panel refuses to run without an access gate).",
			);
		}
		if (options.auth && !options.session) {
			throw new Error(
				"AdminPanel: the `auth` option requires `session` to also be injected (there is nowhere to hold the logged-in identity otherwise).",
			);
		}
		if (options.accounts && !options.session) {
			throw new Error(
				"AdminPanel: the `accounts` option requires `session` to also be injected (there is nowhere to hold the logged-in identity otherwise).",
			);
		}
		if (options.accounts && !options.csrf) {
			throw new Error(
				"AdminPanel: the `accounts` option requires `csrf` to also be injected (the built-in login and the panel's write routes must be CSRF-protected).",
			);
		}
		this.wireSections();
	}

	protected middleware(): MiddlewareHandler<E>[] {
		return [
			async (c, next) => {
				this.warnCsrfMissingOnce(c);
				await next();
			},
			async (c, next) => {
				const options = this.panelOptions;
				if (!options) return c.text("admin not configured", 500);

				/**
				 * The login/logout routes themselves are exempt from the auth gate, the
				 * accounts gate, and `authorize` (otherwise a not-yet-logged-in request
				 * could never reach `/login`, and a logged-in-but-unauthorized request
				 * could never reach `/logout`), but still pass through to `csrfVerify`
				 * below like every other route.
				 */
				if (this.isAuthRoute(c)) return next();

				const identity = this.currentIdentity(c);
				if (this.effectiveAuth() && !identity) {
					const next_ = encodeURIComponent(c.req.path);
					return c.redirect(`${this.resolveBasePath()}/login?next=${next_}`);
				}

				if (options.accounts && identity) {
					/**
					 * The operator row is re-validated against the DB on EVERY request
					 * (not only at login), so deleting the row or setting
					 * `isActive: false` revokes access immediately: the stale session
					 * identity is cleared and the request is sent back to `/login`.
					 */
					const row = await options.accounts.users.retrieve(identity.id);
					if (!row || !row.isActive) {
						this.clearIdentity(c);
						const next_ = encodeURIComponent(c.req.path);
						return c.redirect(`${this.resolveBasePath()}/login?next=${next_}`);
					}

					/**
					 * Superusers bypass permission checks entirely, so their granted set
					 * is never computed (`null`) and the route's required permission is
					 * never even resolved.
					 */
					if (row.isSuperuser) {
						this.requestOperator.set(c.req.raw, { row, granted: null });
					} else {
						/**
						 * The route's required permission is resolved before the granted
						 * set is fetched, so a `SUPERUSER_ONLY` route (the `accounts`
						 * section, unreachable by any non-superuser regardless of granted
						 * permissions) short-circuits to 403 without a wasted query.
						 * Otherwise the operator's own permission set and their groups'
						 * sets are fetched in parallel (rather than one after another) and
						 * unioned into the granted set, then stashed alongside the row so
						 * a view rendered later in this request (`buildNav`'s filter) can
						 * read it without a second fetch.
						 */
						const required = await this.requiredPermission(c);
						if (required === SUPERUSER_ONLY) {
							return c.text("Forbidden", options.denyStatus ?? 403);
						}

						const [ownPermissions, groupPermissions] = await Promise.all([
							options.accounts.users.userPermissions(identity.id),
							options.accounts.groups
								? options.accounts.groups.permissionsForUser(identity.id)
								: Promise.resolve([]),
						]);
						const granted = new Set([...ownPermissions, ...groupPermissions]);
						this.requestOperator.set(c.req.raw, { row, granted });

						/**
						 * The resolved permission (when the route requires one) must be in
						 * the granted set above, compared by literal set membership
						 * (`admin_permissions.ts`).
						 */
						if (required !== null && !granted.has(required)) {
							return c.text("Forbidden", options.denyStatus ?? 403);
						}
					}
				}

				/** When both `accounts` and `authorize` are injected, both must allow (an AND). */
				if (options.authorize) {
					const allowed = await options.authorize(c);
					if (!allowed) return c.text("Forbidden", options.denyStatus ?? 403);
				}

				await next();
			},
			async (c, next) => {
				const csrf = this.panelOptions?.csrf;
				if (!csrf) return next();
				return csrf.verify(c, next);
			},
		];
	}

	/** Whether `c` targets this panel's built-in `/login` or `/logout` route (see `middleware()`'s auth gate). */
	private isAuthRoute(c: Context<E>): boolean {
		const basePath = this.resolveBasePath();
		return c.req.path === `${basePath}/login` || c.req.path === `${basePath}/logout`;
	}

	/**
	 * Resolves the permission string the current request requires under the
	 * accounts gate in `middleware()`, from the request path (with `basePath`
	 * stripped) and HTTP method, using the vocabulary of `admin_permissions.ts`.
	 * Returns `null` when no specific permission is required: the dashboard
	 * (any active operator may see it) and unrecognized paths (which simply fall
	 * through to the 404 they would produce anyway).
	 *
	 * This method is the single source of truth for the route-to-permission
	 * table exercised by the `requiredPermission mapping` test suite
	 * (`test/admin/admin_panel_accounts_ui.test.ts`): when wiring a new route
	 * under any section, add its mapping here and update that table-driven test
	 * so drift between the two is caught.
	 *
	 * Path segments are matched raw (never decoded): permissions are compared by
	 * literal set membership only, so a key segment that does not correspond to a
	 * registered resource never matches any granted permission.
	 *
	 * `POST /resources/<key>` serves both the create form and the list screen's
	 * bulk-action form (see `wireResources`), so the body is peeked via
	 * `c.req.parseBody()` to tell them apart the same way the route handler
	 * does: a string `action` field (present, even empty, only on the
	 * bulk-action form's `<select name="action">`) means bulk action, its
	 * absence means a create submission. Within the bulk-action form,
	 * `action=delete` requires the delete permission; any other value is a
	 * no-op redirect (`handleBulkAction`) that requires no permission at all.
	 * Hono caches the parsed body on the request (`HonoRequest#bodyCache`), so
	 * `Csrf#verify` and the route handler can safely `parseBody` again
	 * afterwards.
	 *
	 * The `accounts` section (operator-account management) resolves to the
	 * `SUPERUSER_ONLY` sentinel for every path under it, regardless of method or
	 * depth: unlike every other section, there is no granted permission string a
	 * non-superuser could hold to reach it.
	 */
	private async requiredPermission(c: Context<E>): Promise<string | typeof SUPERUSER_ONLY | null> {
		const basePath = this.resolveBasePath();
		const path = c.req.path;
		if (path === basePath) return null;
		if (!path.startsWith(`${basePath}/`)) return null;

		const segments = path.slice(basePath.length + 1).split("/");
		const method = c.req.method.toUpperCase();

		if (segments[0] === "jobs") {
			if (method === "GET" && segments.length === 1) return "jobs.view";
			if (
				method === "POST" &&
				segments.length === 3 &&
				(segments[2] === "retry" || segments[2] === "delete")
			) {
				return "jobs.manage";
			}
			return null;
		}

		if (segments[0] === "settings") {
			if (method === "GET" && segments.length === 1) return "settings.view";
			if (method === "POST" && segments.length === 3 && segments[1] === "flags") {
				return "settings.manage";
			}
			if (method === "POST" && segments.length === 2 && segments[1] === "maintenance") {
				return "settings.manage";
			}
			return null;
		}

		if (segments[0] === "audit") {
			if (method === "GET" && segments.length === 1) return "audit.view";
			return null;
		}

		if (segments[0] === "accounts") return SUPERUSER_ONLY;

		if (segments[0] === "resources" && segments.length >= 2 && segments[1] !== "") {
			const key = segments[1];
			if (method === "GET") {
				if (segments.length === 2) return resourcePermission(key, "view");
				if (segments.length === 3) {
					return resourcePermission(key, segments[2] === "new" ? "create" : "view");
				}
				if (segments.length === 4 && segments[3] === "edit") {
					return resourcePermission(key, "update");
				}
				if (segments.length === 4 && segments[3] === "delete") {
					return resourcePermission(key, "delete");
				}
				return null;
			}
			if (method === "POST") {
				if (segments.length === 2) {
					const body = await c.req.parseBody();
					if (typeof body.action === "string") {
						return body.action === "delete" ? resourcePermission(key, "delete") : null;
					}
					return resourcePermission(key, "create");
				}
				/** `POST /resources/<key>/<id>` is the edit form's submission (see `wireResources`). */
				if (segments.length === 3) return resourcePermission(key, "update");
				if (segments.length === 4 && segments[3] === "delete") {
					return resourcePermission(key, "delete");
				}
				return null;
			}
			return null;
		}

		return null;
	}

	/**
	 * Reads the logged-in `AdminIdentity` from the session, if `panelOptions.session`
	 * is injected and holds a well-formed one. `null` otherwise (not logged in, no
	 * session injected, or a malformed stored value).
	 */
	private currentIdentity(c: Context<E>): AdminIdentity | null {
		const session = this.panelOptions?.session;
		if (!session) return null;

		const value = session(c).get(ADMIN_IDENTITY_SESSION_KEY);
		return isAdminIdentity(value) ? value : null;
	}

	/** Stores `identity` in the session as the logged-in operator, if `panelOptions.session` is injected. */
	private setIdentity(c: Context<E>, identity: AdminIdentity): void {
		this.panelOptions?.session?.(c).set(ADMIN_IDENTITY_SESSION_KEY, identity);
	}

	/** Removes the logged-in identity from the session, if `panelOptions.session` is injected. */
	private clearIdentity(c: Context<E>): void {
		this.panelOptions?.session?.(c).unset(ADMIN_IDENTITY_SESSION_KEY);
	}

	/**
	 * The current request's re-validated operator row and granted permission
	 * set, as stashed by `middleware()` (`requestOperator`). `undefined` when
	 * `accounts` is not injected or the request has no logged-in identity.
	 */
	private currentOperator(
		c: Context<E>,
	): { row: AdminAccountsUserRow; granted: ReadonlySet<string> | null } | undefined {
		return this.requestOperator.get(c.req.raw);
	}

	/**
	 * Resolves the auth wiring used by the login/logout routes (`wireAuth`), the
	 * auth gate in `middleware()`, and the default user-tools
	 * (`resolveUserTools`). An explicitly injected `options.auth` always wins —
	 * an escape hatch for e.g. wrapping the credential check with rate limiting;
	 * in that case the returned identity's `id` MUST be an accounts user id,
	 * because the accounts gate re-validates the operator row by `identity.id`
	 * on every request. Otherwise, when `accounts` is injected, a default is
	 * derived from the users service (`authenticate`, labelling the identity
	 * with the row's `label` and falling back to its `username`). `undefined`
	 * when neither is injected: no login/logout routes and no auth gate, exactly
	 * as before (backward compatible).
	 */
	private effectiveAuth(): AdminPanelOptions<E>["auth"] {
		const options = this.panelOptions;
		if (!options) return undefined;
		if (options.auth) return options.auth;

		const accounts = options.accounts;
		if (!accounts) return undefined;
		return {
			authenticate: async (_c, credentials) => {
				const user = await accounts.users.authenticate(credentials);
				return user ? { id: user.id, label: user.label ?? user.username } : null;
			},
		};
	}

	/**
	 * Validates the login screen's `?next=`/`next` redirect target: only a path
	 * confined to this panel's `basePath` is allowed through as-is (an open
	 * redirect guard), anything else — an external URL, a protocol-relative URL,
	 * or simply a look-alike path such as `/adminX` — falls back to `basePath`
	 * itself.
	 */
	private sanitizeNext(raw: string | undefined): string {
		const basePath = this.resolveBasePath();
		if (raw === basePath || raw?.startsWith(`${basePath}/`) || raw?.startsWith(`${basePath}?`)) {
			return raw;
		}
		return basePath;
	}

	/**
	 * `console.warn`s that CSRF is unwired only once, on the first unsafe-method
	 * request (anything other than `GET`/`HEAD`/`OPTIONS`) received while
	 * `panelOptions.csrf` is not injected. Not emitted for GET-only access (leans
	 * toward a safe-by-default posture while not breaking existing backward-compat
	 * tests).
	 */
	private warnCsrfMissingOnce(c: Context<E>): void {
		if (this.panelOptions?.csrf || this.csrfMissingWarned) return;
		if (["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase())) return;

		this.csrfMissingWarned = true;
		console.warn(
			"AdminPanel has no csrf wired. Pass the `csrf` option or verify upstream for CSRF protection.",
		);
	}

	protected register(): void {
		this.get("/", (c) => {
			const options = this.panelOptions;
			if (!options) return c.text("admin not configured", 500);

			const brand = options.brand ?? "Admin";
			const t = bindAdminT(c);
			const resources = this.visibleResources(c);
			const basePath = this.resolveBasePath();
			const allowed = this.permissionFilter(c);

			return c.html(
				<AdminLayout
					brand={brand}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[{ label: t("breadcrumb.home") }]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					{resources.length > 0 ? (
						<div class="module">
							<h2>{t("index.resources")}</h2>
							<table>
								<caption class="visually-hidden">{t("index.resources")}</caption>
								<tbody>
									{resources.map((resource) => (
										<tr>
											<th scope="row">
												<a href={`${basePath}/resources/${resource.key}`}>{resource.label}</a>
											</th>
											<td>
												{resource.canWrite() &&
												allowed(resourcePermission(resource.key, "create")) ? (
													<a
														class="addlink"
														href={`${basePath}/resources/${resource.key}/new`}
														aria-label={t("a11y.addItem", { label: resource.label })}
													>
														{t("action.add")}
													</a>
												) : null}
											</td>
											<td>
												<a
													href={`${basePath}/resources/${resource.key}`}
													aria-label={t("a11y.changeItem", { label: resource.label })}
												>
													{t("action.change")}
												</a>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					) : (
						<>
							<h2>{t("dashboard.welcome")}</h2>
							<p>{t("dashboard.empty")}</p>
						</>
					)}
				</AdminLayout>,
			);
		});
	}

	/** Builds the leading `[Home]` (or `[Home → …]`) breadcrumb segment shared by every non-dashboard screen. */
	private homeBreadcrumb(t: AdminT): AdminBreadcrumb {
		return { href: this.resolveBasePath(), label: t("breadcrumb.home") };
	}

	/** Resolves `panelOptions.basePath` (default `"/admin"`). Named this way because `basePath` is a Hono-reserved name. */
	private resolveBasePath(): string {
		return this.panelOptions?.basePath ?? "/admin";
	}

	/**
	 * The list screen's order when `?o=` is absent or invalid: primary key
	 * descending (newest first), matching the pre-existing `paginate`-based
	 * behavior this replaces. Falls back to no explicit order (DB default) in
	 * the unexpected case where `primaryKey` doesn't name an actual column.
	 */
	private defaultOrderBy(target: AdminResource): { column: Column; direction: "asc" | "desc" }[] {
		const pkColumn = getTableColumns(target.table)[target.primaryKey];
		return pkColumn ? [{ column: pkColumn, direction: "desc" }] : [];
	}

	/** Issues a token string only when `panelOptions.csrf` is injected. `null` when not injected (no hidden input in forms). */
	private csrfToken(c: Context<E>): string | null {
		return this.panelOptions?.csrf?.csrfToken(c) ?? null;
	}

	/**
	 * Resolves the header's user-tools block content. `panelOptions.userTools`, when
	 * injected, always wins. Otherwise, when auth wiring is present (an explicit
	 * `auth` or one derived from `accounts`; see `effectiveAuth`) and the request is
	 * logged in, a default block is built from the session identity (a greeting plus
	 * a "Log out" link posting to this panel's `/logout`), so wiring `auth` or
	 * `accounts` alone gets a working logout control without also having to inject
	 * `userTools`. `undefined` when neither applies (no block rendered, backward
	 * compatible).
	 */
	private resolveUserTools(c: Context<E>): AdminUserTools | undefined {
		const options = this.panelOptions;
		if (options?.userTools) return options.userTools(c);
		if (!this.effectiveAuth()) return undefined;

		const identity = this.currentIdentity(c);
		if (!identity) return undefined;

		const t = bindAdminT(c);
		return {
			greeting: identity.label ?? identity.id,
			links: [
				{ label: t("auth.logOut"), href: `${this.resolveBasePath()}/logout`, method: "post" },
			],
		};
	}

	/**
	 * Pushes one flash message to be shown on the next GET, if `panelOptions.session`
	 * is injected. Does nothing if not injected (message banners are opt-in, same
	 * policy as `recordAudit`).
	 */
	private flashMessage(c: Context<E>, level: AdminMessage["level"], text: string): void {
		const session = this.panelOptions?.session;
		if (!session) return;

		session(c).flash(ADMIN_MESSAGES_FLASH_KEY, [{ level, text }] satisfies AdminMessage[]);
	}

	/**
	 * Consumes and returns the flash messages pushed by `flashMessage`, if
	 * `panelOptions.session` is injected. Returns `[]` when not injected, when nothing
	 * was flashed (a normal GET), or when the stored value's shape is malformed.
	 */
	private consumeMessages(c: Context<E>): AdminMessage[] {
		const session = this.panelOptions?.session;
		if (!session) return [];

		const value = session(c).get(ADMIN_MESSAGES_FLASH_KEY);
		return isAdminMessageArray(value) ? value : [];
	}

	/**
	 * Resolves the post-save redirect target from the pressed submit button's `name`:
	 * `_addanother` redirects to the "new" screen and `_continue` redirects back to
	 * the "edit" screen for the just-saved row. Any button name other than those two —
	 * including `_save` and no button name at all (e.g. a caller posting without one
	 * of these fields) — falls back to the list, which is the pre-existing behavior.
	 */
	private resolveSaveRedirect(body: FormInput, key: string, rowId: string): string {
		const basePath = this.resolveBasePath();
		if (body._addanother !== undefined) return `${basePath}/resources/${key}/new`;
		if (body._continue !== undefined) {
			return `${basePath}/resources/${key}/${encodeURIComponent(rowId)}/edit`;
		}
		return `${basePath}/resources/${key}`;
	}

	/**
	 * Resolves the granted-permission-set filter for the current request:
	 * always `true` when there is nothing to filter against — `accounts` not
	 * injected, the operator unknown (e.g. the login screen), or the operator
	 * being a superuser — and literal set membership in the operator's granted
	 * set (`currentOperator`) otherwise. Shared by `buildNav` and
	 * `visibleResources` so a section or resource link never appears where
	 * opening it would actually 403.
	 */
	private permissionFilter(c: Context<E>): (permission: string) => boolean {
		const operator = this.panelOptions?.accounts ? this.currentOperator(c) : undefined;
		const granted = operator && !operator.row.isSuperuser ? operator.granted : null;
		return (permission) => !granted || granted.has(permission);
	}

	/**
	 * The wired resources visible to the current request's operator: every
	 * resource when `permissionFilter` has nothing to filter against,
	 * otherwise only those whose `resource.<key>.view` permission is in the
	 * operator's granted set. Used by both the dashboard's resource-list
	 * module (`register()`) and `buildNav`'s resource links, so the two never
	 * disagree — a resource that would 403 the operator never appears in
	 * either place.
	 */
	private visibleResources(c: Context<E>): AdminResource[] {
		const allowed = this.permissionFilter(c);
		return (this.panelOptions?.resources ?? []).filter((resource) =>
			allowed(resourcePermission(resource.key, "view")),
		);
	}

	/**
	 * Builds the nav item list, including only wired sections
	 * (jobs/settings/audit/accounts/resources). The dashboard link is always
	 * shown, and the Accounts link is gated on the current request's operator
	 * being a superuser (`currentOperator`) — the only operators who can ever
	 * reach `/accounts/*` (see `requiredPermission`'s `SUPERUSER_ONLY`
	 * resolution) — so a non-superuser never sees a link to a screen that would
	 * 403 them.
	 *
	 * When `accounts` is injected and the current operator is a known
	 * non-superuser, every other section is additionally filtered against that
	 * operator's granted permission set via `permissionFilter`, so a link only
	 * appears if opening it would actually succeed. This filter is skipped
	 * (every wired section shown, as before) when `accounts` is not injected or
	 * the operator is unknown (e.g. the login screen) — both cases where there
	 * is no granted set to check against.
	 */
	private buildNav(c: Context<E>, t: AdminT): AdminNavItem[] {
		const options = this.panelOptions;
		const basePath = this.resolveBasePath();
		const nav: AdminNavItem[] = [{ href: basePath, label: t("nav.dashboard") }];
		if (!options) return nav;

		const operator = options.accounts ? this.currentOperator(c) : undefined;
		const allowed = this.permissionFilter(c);

		if (options.jobs && allowed("jobs.view")) {
			nav.push({ href: `${basePath}/jobs`, label: t("nav.jobs") });
		}
		if (options.settings && allowed("settings.view")) {
			nav.push({ href: `${basePath}/settings`, label: t("nav.settings") });
		}
		if (options.audit && allowed("audit.view")) {
			nav.push({ href: `${basePath}/audit`, label: t("nav.audit") });
		}
		if (options.accounts && operator?.row.isSuperuser) {
			nav.push({ href: `${basePath}/accounts/users`, label: t("nav.accounts") });
		}
		for (const resource of this.visibleResources(c)) {
			nav.push({
				href: `${basePath}/resources/${resource.key}`,
				label: resource.label,
				group: "resource",
			});
		}
		return nav;
	}

	/**
	 * Records one audit log entry if `panelOptions.audit` is injected. Does nothing if
	 * not injected (policy: "recording destination is config-injected; skip if omitted").
	 */
	private async recordAudit(
		c: Context<E>,
		action: string,
		target: string,
		changes?: unknown,
	): Promise<void> {
		const audit = this.panelOptions?.audit;
		if (!audit) return;

		/**
		 * Actor precedence: the injected `audit.actor` callback always wins;
		 * without it, the logged-in identity (its label, falling back to its id)
		 * is used, and the literal `"admin"` remains the last resort for panels
		 * with no auth wiring or no logged-in identity (backward compatible).
		 */
		const identity = this.currentIdentity(c);
		const fallback = identity ? (identity.label ?? identity.id) : "admin";
		const actor = audit.actor ? await audit.actor(c) : fallback;
		await audit.log.record({ actor, action, target, changes });
	}

	/**
	 * Dispatches the list screen's bulk-action form (only `action=delete` is
	 * supported today). Mirrors the single-row delete's two-step contract:
	 * - `action=delete` with one or more rows selected, no `post=yes` yet ->
	 *   renders `AdminResourceBulkDeleteView` so the operator confirms first.
	 * - `action=delete` with `post=yes` (the confirmation form's own submission) ->
	 *   deletes each selected id that still exists, flashes a count message, and
	 *   records one `resource.bulkDelete` audit entry.
	 * - anything else (an unrecognized action, or nothing selected) -> redirects
	 *   back to the list without deleting anything.
	 */
	private async handleBulkAction(
		c: Context<E>,
		target: AdminResource,
		key: string,
		body: FormInput,
	): Promise<Response> {
		const basePath = this.resolveBasePath();
		const listUrl = `${basePath}/resources/${key}`;
		const action = typeof body.action === "string" ? body.action : "";
		const selected = selectedActionIds(body);

		if (action !== "delete" || selected.length === 0) {
			return c.redirect(listUrl, 303);
		}

		if (body.post !== "yes") {
			const t = bindAdminT(c);
			return c.html(
				<AdminLayout
					brand={this.panelOptions?.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[
						this.homeBreadcrumb(t),
						{ href: listUrl, label: target.label },
						{ label: t("action.delete") },
					]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminResourceBulkDeleteView
						basePath={basePath}
						resourceKey={key}
						label={target.label}
						selected={selected}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		}

		let count = 0;
		for (const id of selected) {
			const deleted = await target.model.delete(id);
			if (deleted) count++;
		}

		if (count > 0) {
			await this.recordAudit(c, "resource.bulkDelete", key, { ids: selected, count });
			const t = bindAdminT(c);
			this.flashMessage(c, "success", t("message.deletedCount", { count, label: target.label }));
		}
		return c.redirect(listUrl, 303);
	}

	/**
	 * Called after `super()` completes (after `panelOptions` is assigned), and
	 * additionally registers routes only for injected sections. Since `register()`
	 * registers only the dashboard, this is the single branch point that keeps
	 * uninjected sections from getting routes.
	 */
	private wireSections(): void {
		const options = this.panelOptions;
		if (!options) return;

		if (options.auth || options.accounts) this.wireAuth();
		if (options.jobs) this.wireJobs();
		if (options.settings) this.wireSettings();
		if (options.audit) this.wireAudit();
		if (options.accounts) this.wireAccounts();
		if (options.resources && options.resources.length > 0) this.wireResources();
	}

	/**
	 * Registers `GET`/`POST "/login"` and `POST "/logout"`, wired for an explicit
	 * `auth` or one derived from `accounts` (`effectiveAuth`). The auth gate in
	 * `middleware()` exempts these two paths from itself, the accounts gate, and
	 * `authorize` (see `isAuthRoute`), so they are reachable both logged-out (to
	 * log in) and logged-in-but-unauthorized (to log out).
	 */
	private wireAuth(): void {
		this.get("/login", async (c) => {
			const options = this.panelOptions;
			if (!options || !this.effectiveAuth()) return c.notFound();

			const basePath = this.resolveBasePath();
			if (this.currentIdentity(c)) return c.redirect(basePath, 303);

			const t = bindAdminT(c);
			return c.html(
				<AdminLoginView
					brand={options.brand ?? "Admin"}
					basePath={basePath}
					csrfToken={this.csrfToken(c)}
					next={this.sanitizeNext(c.req.query("next"))}
					error={false}
					username=""
					lang={c.get("language") ?? "en"}
					t={t}
				/>,
			);
		});

		this.post("/login", async (c) => {
			const options = this.panelOptions;
			const auth = this.effectiveAuth();
			if (!options || !auth) return c.notFound();

			const basePath = this.resolveBasePath();
			const body = await c.req.parseBody();
			const username = typeof body.username === "string" ? body.username : "";
			const password = typeof body.password === "string" ? body.password : "";
			const next = this.sanitizeNext(typeof body.next === "string" ? body.next : undefined);

			const identity = await auth.authenticate(c, { username, password });
			/**
			 * When `accounts` is injected, `identity.id` MUST be an accounts user id
			 * (see `effectiveAuth`'s JSDoc) because the accounts gate in
			 * `middleware()` re-validates the operator row by that id on every
			 * request. A misconfigured explicit `auth` that returns an id with no
			 * matching row (or an inactive one) would otherwise log the browser in
			 * only for the very next request's re-validation to fail, clear the
			 * identity, and redirect back to `/login` — an infinite loop. Checking
			 * here instead surfaces the misconfiguration immediately, as an
			 * ordinary invalid-credentials response, and skips storing the identity.
			 */
			const row =
				identity && options.accounts
					? await options.accounts.users.retrieve(identity.id)
					: undefined;
			if (!identity || (options.accounts && (!row || !row.isActive))) {
				const t = bindAdminT(c);
				return c.html(
					<AdminLoginView
						brand={options.brand ?? "Admin"}
						basePath={basePath}
						csrfToken={this.csrfToken(c)}
						next={next}
						error={true}
						username={username}
						lang={c.get("language") ?? "en"}
						t={t}
					/>,
					401,
				);
			}

			/**
			 * Reissues the session id on a successful login (session-fixation defense:
			 * `Session#regenerate`), keeping the session's existing data (including any
			 * CSRF secret already issued to this browser) but with a fresh id.
			 */
			options.session?.(c).regenerate();
			this.setIdentity(c, identity);
			return c.redirect(next, 303);
		});

		this.post("/logout", async (c) => {
			if (!this.effectiveAuth()) return c.notFound();

			this.clearIdentity(c);
			return c.redirect(`${this.resolveBasePath()}/login`, 303);
		});
	}

	/** Registers `GET /jobs`, `POST /jobs/:id/retry`, and `POST /jobs/:id/delete`. */
	private wireJobs(): void {
		this.get("/jobs", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const [pending, failed] = await Promise.all([
				options.jobs.console.listPending(),
				options.jobs.console.listFailed(),
			]);
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[this.homeBreadcrumb(t), { label: t("nav.jobs") }]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminJobsView
						basePath={this.resolveBasePath()}
						pending={pending.map(toJobRow)}
						failed={failed.map(toJobRow)}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/jobs/:id/retry", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const id = c.req.param("id");
			const ok = await options.jobs.console.retryFailed(id);
			await this.recordAudit(c, "job.retry", id, { ok });
			return c.redirect(`${this.resolveBasePath()}/jobs`, 303);
		});

		this.post("/jobs/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const id = c.req.param("id");
			const ok = await options.jobs.console.deleteJob(id);
			await this.recordAudit(c, "job.delete", id, { ok });
			return c.redirect(`${this.resolveBasePath()}/jobs`, 303);
		});
	}

	/** Registers `GET /settings`, `POST /settings/flags/:name`, and `POST /settings/maintenance`. */
	private wireSettings(): void {
		this.get("/settings", async (c) => {
			const options = this.panelOptions;
			if (!options?.settings) return c.notFound();

			const { featureFlags, maintenance } = options.settings;
			const flags = featureFlags
				? await Promise.all(
						featureFlags.names.map(async (name) => ({
							name,
							enabled: await featureFlags.flags.enabled(name),
						})),
					)
				: [];
			const maintenanceState = maintenance ? { enabled: await maintenance.enabled() } : null;
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[this.homeBreadcrumb(t), { label: t("nav.settings") }]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminSettingsView
						basePath={this.resolveBasePath()}
						flags={flags}
						maintenance={maintenanceState}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/settings/flags/:name", async (c) => {
			const featureFlags = this.panelOptions?.settings?.featureFlags;
			if (!featureFlags) return c.notFound();

			const name = c.req.param("name");
			const body = await c.req.parseBody();
			const op = body.op === "enable" ? "enable" : "disable";
			if (op === "enable") await featureFlags.flags.enable(name);
			else await featureFlags.flags.disable(name);

			await this.recordAudit(c, op === "enable" ? "flag.enable" : "flag.disable", name);
			return c.redirect(`${this.resolveBasePath()}/settings`, 303);
		});

		this.post("/settings/maintenance", async (c) => {
			const maintenance = this.panelOptions?.settings?.maintenance;
			if (!maintenance) return c.notFound();

			const body = await c.req.parseBody();
			const op = body.op === "enable" ? "enable" : "disable";
			if (op === "enable") await maintenance.enable();
			else await maintenance.disable();

			await this.recordAudit(
				c,
				op === "enable" ? "maintenance.enable" : "maintenance.disable",
				"maintenance",
			);
			return c.redirect(`${this.resolveBasePath()}/settings`, 303);
		});
	}

	/** Registers `GET /audit`. */
	private wireAudit(): void {
		this.get("/audit", async (c) => {
			const options = this.panelOptions;
			if (!options?.audit) return c.notFound();

			const actor = c.req.query("actor") || undefined;
			const action = c.req.query("action") || undefined;
			const target = c.req.query("target") || undefined;
			const rows = await options.audit.log.list({ actor, action, target });
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[this.homeBreadcrumb(t), { label: t("nav.audit") }]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminAuditView
						basePath={this.resolveBasePath()}
						rows={rows.map(toAuditRow)}
						filter={{ actor, action, target }}
						t={t}
					/>
				</AdminLayout>,
			);
		});
	}

	/**
	 * Renders the accounts-user create/edit form screen (shared by the `new`
	 * GET, the `new`/edit POST failure re-renders, and the `setPassword` POST
	 * failure re-render — see `wireAccounts`), wrapped in `AdminLayout` with the
	 * accounts breadcrumb trail. `status` defaults to `200` (the initial GET);
	 * every failure re-render passes `422`.
	 */
	private renderAccountsUserForm(
		c: Context<E>,
		args: {
			mode: "new" | "edit";
			id?: string;
			values: { username: string; label: string; isActive: boolean; isSuperuser: boolean };
			permissionOptions: AdminAccountsCheckboxOption[];
			unknownPermissions: string[];
			groupOptions?: AdminAccountsCheckboxOption[];
			error?: string;
			passwordError?: string;
			status?: ContentfulStatusCode;
		},
	): Response | Promise<Response> {
		const options = this.panelOptions;
		const basePath = this.resolveBasePath();
		const listHref = `${basePath}/accounts/users`;
		const t = bindAdminT(c);
		const action =
			args.mode === "new" ? listHref : `${listHref}/${encodeURIComponent(args.id ?? "")}`;

		return c.html(
			<AdminLayout
				brand={options?.brand ?? "Admin"}
				nav={this.buildNav(c, t)}
				resourcesLabel={t("index.resources")}
				lang={c.get("language") ?? "en"}
				breadcrumbs={[
					this.homeBreadcrumb(t),
					{ href: listHref, label: t("nav.accounts") },
					{
						label:
							args.mode === "new" ? t("accounts.users.newTitle") : t("accounts.users.editTitle"),
					},
				]}
				messages={this.consumeMessages(c)}
				userTools={this.resolveUserTools(c)}
				csrfToken={this.csrfToken(c)}
				currentPath={c.req.path}
				t={t}
			>
				<AdminAccountsUsersFormView
					basePath={basePath}
					mode={args.mode}
					action={action}
					id={args.id}
					values={args.values}
					permissionOptions={args.permissionOptions}
					unknownPermissions={args.unknownPermissions}
					groupOptions={args.groupOptions}
					error={args.error ?? null}
					passwordError={args.passwordError ?? null}
					csrfToken={this.csrfToken(c)}
					t={t}
				/>
			</AdminLayout>,
			args.status ?? 200,
		);
	}

	/**
	 * Registers the superuser-only operator accounts screen (`/accounts/users*`;
	 * see `AdminPanelOptions.accounts`). Every route under this prefix resolves
	 * to `requiredPermission`'s `SUPERUSER_ONLY` sentinel, so `middleware()`
	 * denies a non-superuser before any handler here runs — these handlers
	 * still guard on `options?.accounts` defensively (same convention as every
	 * other `wire*` method), but never need to re-check the operator's role.
	 *
	 * Group membership editing (`groups` checkboxes, `setUserGroups`) is
	 * included whenever `AdminPanelOptions.accounts.groups` is injected. The
	 * dedicated groups management screen (`/accounts/groups*`, group CRUD
	 * rather than membership editing) is registered separately by
	 * `wireAccountsGroups`, called at the end of this method.
	 */
	private wireAccounts(): void {
		this.get("/accounts/users", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const query = c.req.query("q") ?? "";
			const page = parsePage(c.req.query("p") ?? undefined);
			const [rows, total] = await Promise.all([
				options.accounts.users.listUsers({
					query: query || undefined,
					limit: PAGE_SIZE,
					offset: page * PAGE_SIZE,
				}),
				options.accounts.users.count(query || undefined),
			]);
			const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[this.homeBreadcrumb(t), { label: t("nav.accounts") }]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminAccountsUsersListView
						basePath={this.resolveBasePath()}
						rows={rows}
						query={query}
						page={page}
						pageCount={pageCount}
						total={total}
						groupsHref={
							options.accounts.groups ? `${this.resolveBasePath()}/accounts/groups` : undefined
						}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.get("/accounts/users/new", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const known = knownAccountPermissions(options.resources ?? []);
			const groups = options.accounts.groups
				? await options.accounts.groups.listGroups()
				: undefined;

			return this.renderAccountsUserForm(c, {
				mode: "new",
				values: { username: "", label: "", isActive: true, isSuperuser: false },
				permissionOptions: buildPermissionOptions(known, new Set()),
				unknownPermissions: [],
				groupOptions: groups ? buildGroupOptions(groups, new Set()) : undefined,
			});
		});

		this.post("/accounts/users", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();
			const accounts = options.accounts;

			const body = await c.req.parseBody({ all: true });
			const username = stringFormField(body, "username");
			const password = stringFormField(body, "password");
			const label = stringFormField(body, "label");
			const isActive = body.isActive !== undefined;
			const isSuperuser = body.isSuperuser !== undefined;
			const known = knownAccountPermissions(options.resources ?? []);
			const { checkedPermissions } = mergePermissionSelection(
				known,
				[],
				multiValueField(body, "permissions"),
			);
			const selectedGroups = multiValueField(body, "groups");

			const t = bindAdminT(c);
			const rerender = async (error: string) => {
				const groups = accounts.groups ? await accounts.groups.listGroups() : undefined;
				return this.renderAccountsUserForm(c, {
					mode: "new",
					values: { username, label, isActive, isSuperuser },
					permissionOptions: buildPermissionOptions(known, new Set(checkedPermissions)),
					unknownPermissions: [],
					groupOptions: groups ? buildGroupOptions(groups, new Set(selectedGroups)) : undefined,
					error,
					status: 422,
				});
			};

			let created: AdminAccountsUserRow;
			try {
				created = await options.accounts.users.createUser({
					username,
					password,
					label: label || null,
					isActive,
					isSuperuser,
					permissions: checkedPermissions,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return rerender(t("accounts.users.saveError", { detail }));
			}

			if (options.accounts.groups)
				await options.accounts.groups.setUserGroups(created.id, selectedGroups);

			await this.recordAudit(c, "accounts.user.create", created.id, {
				username: created.username,
				label: created.label,
				isActive: created.isActive,
				isSuperuser: created.isSuperuser,
				permissions: checkedPermissions,
			});

			this.flashMessage(c, "success", t("message.added", { label: t("accounts.users.singular") }));
			return c.redirect(`${this.resolveBasePath()}/accounts/users`, 303);
		});

		this.get("/accounts/users/:id/edit", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const id = c.req.param("id");
			const row = await options.accounts.users.retrieve(id);
			if (!row) return c.notFound();

			const known = knownAccountPermissions(options.resources ?? []);
			const knownSet = new Set(known);
			const [stored, groups, memberOfRows] = await Promise.all([
				options.accounts.users.userPermissions(id),
				options.accounts.groups ? options.accounts.groups.listGroups() : Promise.resolve(undefined),
				options.accounts.groups
					? options.accounts.groups.userGroups(id)
					: Promise.resolve(undefined),
			]);
			const memberOf = memberOfRows ? new Set(memberOfRows.map((group) => group.id)) : undefined;

			return this.renderAccountsUserForm(c, {
				mode: "edit",
				id,
				values: {
					username: row.username,
					label: row.label ?? "",
					isActive: row.isActive,
					isSuperuser: row.isSuperuser,
				},
				permissionOptions: buildPermissionOptions(
					known,
					new Set(stored.filter((p) => knownSet.has(p))),
				),
				unknownPermissions: stored.filter((p) => !knownSet.has(p)),
				groupOptions: groups ? buildGroupOptions(groups, memberOf ?? new Set()) : undefined,
			});
		});

		this.post("/accounts/users/:id", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();
			const accounts = options.accounts;

			const id = c.req.param("id");
			const existing = await accounts.users.retrieve(id);
			if (!existing) return c.notFound();

			const body = await c.req.parseBody({ all: true });
			const username = stringFormField(body, "username");
			const label = stringFormField(body, "label");
			const isActive = body.isActive !== undefined;
			const isSuperuser = body.isSuperuser !== undefined;
			const known = knownAccountPermissions(options.resources ?? []);
			const stored = await accounts.users.userPermissions(id);
			const { checkedPermissions, retainedUnknown, nextPermissions } = mergePermissionSelection(
				known,
				stored,
				multiValueField(body, "permissions"),
			);
			const selectedGroups = multiValueField(body, "groups");

			const t = bindAdminT(c);
			const rerender = async (error: string) => {
				const groups = accounts.groups ? await accounts.groups.listGroups() : undefined;
				return this.renderAccountsUserForm(c, {
					mode: "edit",
					id,
					values: { username, label, isActive, isSuperuser },
					permissionOptions: buildPermissionOptions(known, new Set(checkedPermissions)),
					unknownPermissions: retainedUnknown,
					groupOptions: groups ? buildGroupOptions(groups, new Set(selectedGroups)) : undefined,
					error,
					status: 422,
				});
			};

			/**
			 * Refusing to deactivate or demote the last remaining active superuser
			 * is enforced by the accounts service itself (`protectLastActiveSuperuser`),
			 * as a single conditional write rather than a separate read-then-write
			 * check here, so concurrent requests can't both pass a check and both
			 * apply (see `AdminAccountsUsers#updateUser`'s JSDoc).
			 */
			let updated: AdminAccountsUserRow | undefined;
			try {
				updated = await options.accounts.users.updateUser(
					id,
					{ username, label: label || null, isActive, isSuperuser },
					{ protectLastActiveSuperuser: true },
				);
			} catch (err) {
				if (err instanceof LastActiveSuperuserError) {
					return rerender(t("accounts.users.lastActiveSuperuserError"));
				}
				const detail = err instanceof Error ? err.message : String(err);
				return rerender(t("accounts.users.saveError", { detail }));
			}
			if (!updated) return c.notFound();

			await options.accounts.users.setUserPermissions(id, nextPermissions);
			if (options.accounts.groups) await options.accounts.groups.setUserGroups(id, selectedGroups);

			await this.recordAudit(c, "accounts.user.update", id, {
				username: updated.username,
				label: updated.label,
				isActive: updated.isActive,
				isSuperuser: updated.isSuperuser,
				permissions: nextPermissions,
			});

			this.flashMessage(
				c,
				"success",
				t("message.changed", { label: t("accounts.users.singular") }),
			);
			return c.redirect(
				`${this.resolveBasePath()}/accounts/users/${encodeURIComponent(id)}/edit`,
				303,
			);
		});

		this.post("/accounts/users/:id/password", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const id = c.req.param("id");
			const existing = await options.accounts.users.retrieve(id);
			if (!existing) return c.notFound();

			const body = await c.req.parseBody();
			const password = stringFormField(body, "password");
			const t = bindAdminT(c);

			try {
				await options.accounts.users.setPassword(id, password);
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				const known = knownAccountPermissions(options.resources ?? []);
				const knownSet = new Set(known);
				const [stored, groups, memberOfRows] = await Promise.all([
					options.accounts.users.userPermissions(id),
					options.accounts.groups
						? options.accounts.groups.listGroups()
						: Promise.resolve(undefined),
					options.accounts.groups
						? options.accounts.groups.userGroups(id)
						: Promise.resolve(undefined),
				]);
				const memberOf = memberOfRows ? new Set(memberOfRows.map((group) => group.id)) : undefined;

				return this.renderAccountsUserForm(c, {
					mode: "edit",
					id,
					values: {
						username: existing.username,
						label: existing.label ?? "",
						isActive: existing.isActive,
						isSuperuser: existing.isSuperuser,
					},
					permissionOptions: buildPermissionOptions(
						known,
						new Set(stored.filter((p) => knownSet.has(p))),
					),
					unknownPermissions: stored.filter((p) => !knownSet.has(p)),
					groupOptions: groups ? buildGroupOptions(groups, memberOf ?? new Set()) : undefined,
					passwordError: t("accounts.users.saveError", { detail }),
					status: 422,
				});
			}

			await this.recordAudit(c, "accounts.user.setPassword", id);
			this.flashMessage(
				c,
				"success",
				t("message.changed", { label: t("accounts.users.singular") }),
			);
			return c.redirect(
				`${this.resolveBasePath()}/accounts/users/${encodeURIComponent(id)}/edit`,
				303,
			);
		});

		this.get("/accounts/users/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const id = c.req.param("id");
			const row = await options.accounts.users.retrieve(id);
			if (!row) return c.notFound();

			const t = bindAdminT(c);
			const basePath = this.resolveBasePath();
			const listHref = `${basePath}/accounts/users`;

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[
						this.homeBreadcrumb(t),
						{ href: listHref, label: t("nav.accounts") },
						{ href: `${listHref}/${encodeURIComponent(id)}/edit`, label: row.username },
						{ label: t("action.delete") },
					]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminAccountsUsersDeleteView
						basePath={basePath}
						id={id}
						username={row.username}
						label={row.label}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/accounts/users/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts) return c.notFound();

			const id = c.req.param("id");
			const existing = await options.accounts.users.retrieve(id);
			if (!existing) return c.notFound();

			const listUrl = `${this.resolveBasePath()}/accounts/users`;
			const body = await c.req.parseBody();
			if (body.post !== "yes") return c.redirect(listUrl, 303);

			const t = bindAdminT(c);

			/**
			 * Same accounts-service guard as the update handler
			 * (`protectLastActiveSuperuser`): an atomic conditional delete, not a
			 * separate check-then-act read.
			 */
			try {
				await options.accounts.users.deleteUser(id, { protectLastActiveSuperuser: true });
			} catch (err) {
				if (!(err instanceof LastActiveSuperuserError)) throw err;
				this.flashMessage(c, "error", t("accounts.users.lastActiveSuperuserError"));
				return c.redirect(`${listUrl}/${encodeURIComponent(id)}/edit`, 303);
			}
			if (options.accounts.groups) await options.accounts.groups.setUserGroups(id, []);
			await this.recordAudit(c, "accounts.user.delete", id);

			this.flashMessage(
				c,
				"success",
				t("message.deleted", { label: t("accounts.users.singular") }),
			);
			return c.redirect(listUrl, 303);
		});

		this.wireAccountsGroups();
	}

	/**
	 * Registers the superuser-only operator-groups management screen
	 * (`/accounts/groups*`), called at the end of `wireAccounts`. Distinct from
	 * that method's group-membership checkboxes (which edit which groups a
	 * user belongs to): this screen manages the groups themselves — their name
	 * and their own permission set (`AdminAccountsGroups#createGroup`/
	 * `updateGroup`/`setGroupPermissions`/`deleteGroup`).
	 *
	 * Every route here also resolves to `requiredPermission`'s `SUPERUSER_ONLY`
	 * sentinel (it falls under the `accounts` path prefix), so `middleware()`
	 * denies a non-superuser before any handler runs. Each handler still
	 * guards on `options?.accounts?.groups` defensively: when `groups` is not
	 * injected, every route under this prefix is a 404, same convention as
	 * every other optional section.
	 */
	private wireAccountsGroups(): void {
		this.get("/accounts/groups", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const rows = await options.accounts.groups.listGroups();
			const t = bindAdminT(c);
			const basePath = this.resolveBasePath();

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[
						this.homeBreadcrumb(t),
						{ href: `${basePath}/accounts/users`, label: t("nav.accounts") },
						{ label: t("accounts.groups.title") },
					]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminAccountsGroupsListView
						basePath={basePath}
						rows={rows}
						usersHref={`${basePath}/accounts/users`}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.get("/accounts/groups/new", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const known = knownAccountPermissions(options.resources ?? []);

			return this.renderAccountsGroupForm(c, {
				mode: "new",
				values: { name: "" },
				permissionOptions: buildPermissionOptions(known, new Set()),
				unknownPermissions: [],
			});
		});

		this.post("/accounts/groups", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const body = await c.req.parseBody({ all: true });
			const name = stringFormField(body, "name");
			const known = knownAccountPermissions(options.resources ?? []);
			const { checkedPermissions } = mergePermissionSelection(
				known,
				[],
				multiValueField(body, "permissions"),
			);

			const t = bindAdminT(c);
			const rerender = (error: string) =>
				this.renderAccountsGroupForm(c, {
					mode: "new",
					values: { name },
					permissionOptions: buildPermissionOptions(known, new Set(checkedPermissions)),
					unknownPermissions: [],
					error,
					status: 422,
				});

			let created: AdminAccountsGroupRow;
			try {
				created = await options.accounts.groups.createGroup({
					name,
					permissions: checkedPermissions,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return rerender(t("accounts.groups.saveError", { detail }));
			}

			await this.recordAudit(c, "accounts.group.create", created.id, {
				name: created.name,
				permissions: checkedPermissions,
			});

			this.flashMessage(c, "success", t("message.added", { label: t("accounts.groups.singular") }));
			return c.redirect(`${this.resolveBasePath()}/accounts/groups`, 303);
		});

		this.get("/accounts/groups/:id/edit", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const id = c.req.param("id");
			const row = await findGroup(options.accounts.groups, id);
			if (!row) return c.notFound();

			const known = knownAccountPermissions(options.resources ?? []);
			const knownSet = new Set(known);
			const stored = await options.accounts.groups.groupPermissions(id);

			return this.renderAccountsGroupForm(c, {
				mode: "edit",
				id,
				values: { name: row.name },
				permissionOptions: buildPermissionOptions(
					known,
					new Set(stored.filter((p) => knownSet.has(p))),
				),
				unknownPermissions: stored.filter((p) => !knownSet.has(p)),
			});
		});

		this.post("/accounts/groups/:id", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const id = c.req.param("id");
			const existing = await findGroup(options.accounts.groups, id);
			if (!existing) return c.notFound();

			const body = await c.req.parseBody({ all: true });
			const name = stringFormField(body, "name");
			const known = knownAccountPermissions(options.resources ?? []);
			const stored = await options.accounts.groups.groupPermissions(id);
			const { checkedPermissions, retainedUnknown, nextPermissions } = mergePermissionSelection(
				known,
				stored,
				multiValueField(body, "permissions"),
			);

			const t = bindAdminT(c);
			const rerender = (error: string) =>
				this.renderAccountsGroupForm(c, {
					mode: "edit",
					id,
					values: { name },
					permissionOptions: buildPermissionOptions(known, new Set(checkedPermissions)),
					unknownPermissions: retainedUnknown,
					error,
					status: 422,
				});

			let updated: AdminAccountsGroupRow | undefined;
			try {
				updated = await options.accounts.groups.updateGroup(id, { name });
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return rerender(t("accounts.groups.saveError", { detail }));
			}
			if (!updated) return c.notFound();

			await options.accounts.groups.setGroupPermissions(id, nextPermissions);

			await this.recordAudit(c, "accounts.group.update", id, {
				name: updated.name,
				permissions: nextPermissions,
			});

			this.flashMessage(
				c,
				"success",
				t("message.changed", { label: t("accounts.groups.singular") }),
			);
			return c.redirect(
				`${this.resolveBasePath()}/accounts/groups/${encodeURIComponent(id)}/edit`,
				303,
			);
		});

		this.get("/accounts/groups/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const id = c.req.param("id");
			const row = await findGroup(options.accounts.groups, id);
			if (!row) return c.notFound();

			const t = bindAdminT(c);
			const basePath = this.resolveBasePath();
			const usersHref = `${basePath}/accounts/users`;
			const listHref = `${basePath}/accounts/groups`;

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(c, t)}
					resourcesLabel={t("index.resources")}
					lang={c.get("language") ?? "en"}
					breadcrumbs={[
						this.homeBreadcrumb(t),
						{ href: usersHref, label: t("nav.accounts") },
						{ href: listHref, label: t("accounts.groups.title") },
						{ href: `${listHref}/${encodeURIComponent(id)}/edit`, label: row.name },
						{ label: t("action.delete") },
					]}
					messages={this.consumeMessages(c)}
					userTools={this.resolveUserTools(c)}
					csrfToken={this.csrfToken(c)}
					currentPath={c.req.path}
					t={t}
				>
					<AdminAccountsGroupsDeleteView
						basePath={basePath}
						id={id}
						name={row.name}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/accounts/groups/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.accounts?.groups) return c.notFound();

			const id = c.req.param("id");
			const existing = await findGroup(options.accounts.groups, id);
			if (!existing) return c.notFound();

			const listUrl = `${this.resolveBasePath()}/accounts/groups`;
			const body = await c.req.parseBody();
			if (body.post !== "yes") return c.redirect(listUrl, 303);

			const t = bindAdminT(c);
			await options.accounts.groups.deleteGroup(id);
			await this.recordAudit(c, "accounts.group.delete", id);

			this.flashMessage(
				c,
				"success",
				t("message.deleted", { label: t("accounts.groups.singular") }),
			);
			return c.redirect(listUrl, 303);
		});
	}

	/**
	 * Renders the accounts-group create/edit form screen (shared by the `new`
	 * GET and the `new`/edit POST failure re-renders — see
	 * `wireAccountsGroups`), wrapped in `AdminLayout` with the accounts/groups
	 * breadcrumb trail. `status` defaults to `200` (the initial GET); a
	 * failure re-render passes `422`.
	 */
	private renderAccountsGroupForm(
		c: Context<E>,
		args: {
			mode: "new" | "edit";
			id?: string;
			values: { name: string };
			permissionOptions: AdminAccountsCheckboxOption[];
			unknownPermissions: string[];
			error?: string;
			status?: ContentfulStatusCode;
		},
	): Response | Promise<Response> {
		const options = this.panelOptions;
		const basePath = this.resolveBasePath();
		const usersHref = `${basePath}/accounts/users`;
		const listHref = `${basePath}/accounts/groups`;
		const t = bindAdminT(c);
		const action =
			args.mode === "new" ? listHref : `${listHref}/${encodeURIComponent(args.id ?? "")}`;

		return c.html(
			<AdminLayout
				brand={options?.brand ?? "Admin"}
				nav={this.buildNav(c, t)}
				resourcesLabel={t("index.resources")}
				lang={c.get("language") ?? "en"}
				breadcrumbs={[
					this.homeBreadcrumb(t),
					{ href: usersHref, label: t("nav.accounts") },
					{ href: listHref, label: t("accounts.groups.title") },
					{
						label:
							args.mode === "new" ? t("accounts.groups.newTitle") : t("accounts.groups.editTitle"),
					},
				]}
				messages={this.consumeMessages(c)}
				userTools={this.resolveUserTools(c)}
				csrfToken={this.csrfToken(c)}
				currentPath={c.req.path}
				t={t}
			>
				<AdminAccountsGroupsFormView
					basePath={basePath}
					mode={args.mode}
					action={action}
					id={args.id}
					values={args.values}
					permissionOptions={args.permissionOptions}
					unknownPermissions={args.unknownPermissions}
					error={args.error ?? null}
					csrfToken={this.csrfToken(c)}
					t={t}
				/>
			</AdminLayout>,
			args.status ?? 200,
		);
	}

	/**
	 * Registers list/show/create/edit/delete routes for each resource in
	 * `panelOptions.resources`. `key` is embedded literally into the route path, and
	 * each handler resolves it at request time via
	 * `this.panelOptions?.resources?.find((r) => r.key === key)` (same
	 * request-time-reference convention used across the panel, as in `register()`).
	 * Write routes (create/edit/delete) are registered only for resources where
	 * `resource.canWrite()` (whether `form()` is implemented) is `true`.
	 */
	private wireResources(): void {
		const resources = this.panelOptions?.resources ?? [];

		for (const resource of resources) {
			const key = resource.key;
			const resolve = (): AdminResource | undefined =>
				this.panelOptions?.resources?.find((candidate) => candidate.key === key);

			this.get(`/resources/${key}`, async (c) => {
				const options = this.panelOptions;
				const target = resolve();
				if (!options || !target) return c.notFound();

				const query = c.req.query("q") ?? "";
				const filterDefs = target.filters?.() ?? [];
				const selected: Record<string, string | undefined> = {};
				for (const def of filterDefs) {
					selected[def.column] = c.req.query(def.column) || undefined;
				}

				const search = query ? target.searchWhere(query) : undefined;
				const filter = target.filterWhere(selected);
				const baseWhere = combineWhere(search, filter);

				const dhColumnName = target.dateHierarchy?.();
				const dhColumn = dhColumnName ? getTableColumns(target.table)[dhColumnName] : undefined;
				if (dhColumnName && !dhColumn) {
					throw new Error(
						`AdminResource "${target.key}": dateHierarchy() specified a nonexistent column name "${dhColumnName}"`,
					);
				}
				const dhQuery = parseDateHierarchyQuery(
					c.req.query("dhy"),
					c.req.query("dhm"),
					c.req.query("dhd"),
				);
				const where = dhColumn
					? combineWhere(baseWhere, dateHierarchyPeriodWhere(dhColumn, dhQuery))
					: baseWhere;

				const displayColumns = target.columns();
				const sort = parseSort(c.req.query("o") ?? undefined, displayColumns.length);
				const orderBy: { column: Column; direction: "asc" | "desc" }[] = sort
					? [{ column: displayColumns[sort.index].column, direction: sort.direction }]
					: this.defaultOrderBy(target);

				const page = parsePage(c.req.query("p") ?? undefined);
				const offset = page * PAGE_SIZE;
				const lang = c.get("language") ?? "en";
				const t = bindAdminT(c);
				const allowed = this.permissionFilter(c);
				const canCreate = target.canWrite() && allowed(resourcePermission(key, "create"));
				const canUpdate = target.canWrite() && allowed(resourcePermission(key, "update"));
				const canDelete = target.canWrite() && allowed(resourcePermission(key, "delete"));

				const [rows, total, dateHierarchy] = await Promise.all([
					target.model.listPage({ where, orderBy, limit: PAGE_SIZE, offset }),
					target.model.count(where),
					dhColumn && dhColumnName
						? buildDateHierarchyNav(
								target,
								dhColumnName,
								dhColumn,
								baseWhere,
								dhQuery,
								this.resolveBasePath(),
								key,
								query,
								selected,
								lang,
								t,
							)
						: Promise.resolve(undefined),
				]);
				const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

				return c.html(
					<AdminLayout
						brand={options.brand ?? "Admin"}
						nav={this.buildNav(c, t)}
						resourcesLabel={t("index.resources")}
						lang={c.get("language") ?? "en"}
						breadcrumbs={[this.homeBreadcrumb(t), { label: target.label }]}
						messages={this.consumeMessages(c)}
						userTools={this.resolveUserTools(c)}
						csrfToken={this.csrfToken(c)}
						currentPath={c.req.path}
						t={t}
					>
						<AdminResourceListView
							basePath={this.resolveBasePath()}
							resourceKey={key}
							label={target.label}
							columns={displayColumns.map((column) => column.name)}
							rows={rows}
							primaryKey={target.primaryKey}
							canCreate={canCreate}
							canUpdate={canUpdate}
							canDelete={canDelete}
							searchEnabled={(target.searchColumns?.() ?? []).length > 0}
							query={query}
							filters={filterDefs}
							activeFilters={selected}
							sort={sort}
							page={page}
							pageCount={pageCount}
							total={total}
							dateHierarchy={dateHierarchy}
							csrfToken={this.csrfToken(c)}
							t={t}
						/>
					</AdminLayout>,
				);
			});

			if (resource.canWrite()) {
				this.get(`/resources/${key}/new`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const binding = form.bind();
					const inlineGroups = await buildInlineGroups(target);
					const t = bindAdminT(c);
					return c.html(
						<AdminLayout
							brand={options.brand ?? "Admin"}
							nav={this.buildNav(c, t)}
							resourcesLabel={t("index.resources")}
							lang={c.get("language") ?? "en"}
							breadcrumbs={[
								this.homeBreadcrumb(t),
								{ href: `${this.resolveBasePath()}/resources/${key}`, label: target.label },
								{ label: t("action.add") },
							]}
							messages={this.consumeMessages(c)}
							userTools={this.resolveUserTools(c)}
							csrfToken={this.csrfToken(c)}
							currentPath={c.req.path}
							t={t}
						>
							<AdminResourceFormView
								basePath={this.resolveBasePath()}
								resourceKey={key}
								label={target.label}
								mode="new"
								form={binding}
								action={`${this.resolveBasePath()}/resources/${key}`}
								inlineGroups={inlineGroups}
								csrfToken={this.csrfToken(c)}
								t={t}
							/>
						</AdminLayout>,
					);
				});
			}

			this.get(`/resources/${key}/:id`, async (c) => {
				const options = this.panelOptions;
				const target = resolve();
				if (!options || !target) return c.notFound();

				const row = await target.model.retrieve(c.req.param("id"));
				if (!row) return c.notFound();

				const t = bindAdminT(c);
				const allowed = this.permissionFilter(c);
				const canUpdate = target.canWrite() && allowed(resourcePermission(key, "update"));
				const canDelete = target.canWrite() && allowed(resourcePermission(key, "delete"));
				return c.html(
					<AdminLayout
						brand={options.brand ?? "Admin"}
						nav={this.buildNav(c, t)}
						resourcesLabel={t("index.resources")}
						lang={c.get("language") ?? "en"}
						breadcrumbs={[
							this.homeBreadcrumb(t),
							{ href: `${this.resolveBasePath()}/resources/${key}`, label: target.label },
							{ label: t("resource.showTitle", { label: target.label }) },
						]}
						messages={this.consumeMessages(c)}
						userTools={this.resolveUserTools(c)}
						csrfToken={this.csrfToken(c)}
						currentPath={c.req.path}
						t={t}
					>
						<AdminResourceShowView
							basePath={this.resolveBasePath()}
							resourceKey={key}
							label={target.label}
							columns={target.columns().map((column) => column.name)}
							row={row}
							primaryKey={target.primaryKey}
							canUpdate={canUpdate}
							canDelete={canDelete}
							t={t}
						/>
					</AdminLayout>,
				);
			});

			if (resource.canWrite()) {
				/**
				 * Serves both the create form's submission and the list screen's bulk-action
				 * form (`AdminResourceListView`'s `changelist-form`), since both post to this
				 * same URL. Distinguished by the presence of `action` in the body: the create
				 * form has no such field, while the bulk-action form always includes
				 * `<select name="action">` (empty string when nothing is chosen). `{ all: true }`
				 * is required so repeated `_selected_action` checkboxes survive as an array
				 * (Hono's default `parseBody` keeps only the last value of a repeated field).
				 */
				this.post(`/resources/${key}`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const body = await c.req.parseBody({ all: true });
					if (typeof body.action === "string") return this.handleBulkAction(c, target, key, body);

					/**
					 * Parent and every inline row are validated up front, before any write
					 * (see the module JSDoc "Persisting inline child rows"): only when
					 * `allValid` holds does the handler proceed to create the parent and
					 * persist inline rows.
					 */
					const parentResult = await form.validate(body);
					const inlinePlans = await planAllInlineRows(target, body);
					const allValid = parentResult.ok && allInlineRowsValid(inlinePlans);

					if (!allValid) {
						const binding = form.bind({
							errors: parentResult.ok ? [] : parentResult.errors,
							values: parentResult.ok ? body : parentResult.values,
						});
						const inlineGroups = buildInlineGroupsFromBody(target, body, inlinePlans);
						const t = bindAdminT(c);
						return c.html(
							<AdminLayout
								brand={options.brand ?? "Admin"}
								nav={this.buildNav(c, t)}
								resourcesLabel={t("index.resources")}
								lang={c.get("language") ?? "en"}
								breadcrumbs={[
									this.homeBreadcrumb(t),
									{ href: `${this.resolveBasePath()}/resources/${key}`, label: target.label },
									{ label: t("action.add") },
								]}
								userTools={this.resolveUserTools(c)}
								csrfToken={this.csrfToken(c)}
								currentPath={c.req.path}
								t={t}
							>
								<AdminResourceFormView
									basePath={this.resolveBasePath()}
									resourceKey={key}
									label={target.label}
									mode="new"
									form={binding}
									action={`${this.resolveBasePath()}/resources/${key}`}
									inlineGroups={inlineGroups}
									csrfToken={this.csrfToken(c)}
									t={t}
								/>
							</AdminLayout>,
							422,
						);
					}

					const created = await target.model.create(parentResult.value);
					const createdId = stringify(created[target.primaryKey]);
					await persistInlineRows(target, inlinePlans, createdId);
					await this.recordAudit(c, "resource.create", `${key}/${createdId}`);

					const t = bindAdminT(c);
					this.flashMessage(c, "success", t("message.added", { label: target.label }));
					return c.redirect(this.resolveSaveRedirect(body, key, createdId), 303);
				});

				this.get(`/resources/${key}/:id/edit`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const id = c.req.param("id");
					const row = await target.model.retrieve(id);
					if (!row) return c.notFound();

					const binding = form.bind({ values: form.toInput(row) });
					const inlineGroups = await buildInlineGroups(target, id);
					const t = bindAdminT(c);
					return c.html(
						<AdminLayout
							brand={options.brand ?? "Admin"}
							nav={this.buildNav(c, t)}
							resourcesLabel={t("index.resources")}
							lang={c.get("language") ?? "en"}
							breadcrumbs={[
								this.homeBreadcrumb(t),
								{ href: `${this.resolveBasePath()}/resources/${key}`, label: target.label },
								{ label: t("action.change") },
							]}
							messages={this.consumeMessages(c)}
							userTools={this.resolveUserTools(c)}
							csrfToken={this.csrfToken(c)}
							currentPath={c.req.path}
							t={t}
						>
							<AdminResourceFormView
								basePath={this.resolveBasePath()}
								resourceKey={key}
								label={target.label}
								mode="edit"
								form={binding}
								action={`${this.resolveBasePath()}/resources/${key}/${id}`}
								id={id}
								inlineGroups={inlineGroups}
								csrfToken={this.csrfToken(c)}
								t={t}
							/>
						</AdminLayout>,
					);
				});

				this.post(`/resources/${key}/:id`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const id = c.req.param("id");
					const existing = await target.model.retrieve(id);
					if (!existing) return c.notFound();

					/**
					 * `{ all: true }` is needed here too (not just on create), so a child
					 * inline row's own multi-value fields (e.g. a `checkbox-group`) survive
					 * as an array rather than collapsing to their last value.
					 */
					const body = await c.req.parseBody({ all: true });

					/**
					 * Parent and every inline row are validated up front, before any write
					 * (see the module JSDoc "Persisting inline child rows"): only when
					 * `allValid` holds does the handler proceed to update the parent and
					 * persist inline rows.
					 */
					const parentResult = await form.validate(body);
					const inlinePlans = await planAllInlineRows(target, body);
					const allValid = parentResult.ok && allInlineRowsValid(inlinePlans);

					if (!allValid) {
						const binding = form.bind({
							errors: parentResult.ok ? [] : parentResult.errors,
							values: parentResult.ok ? body : parentResult.values,
						});
						const inlineGroups = buildInlineGroupsFromBody(target, body, inlinePlans);
						const t = bindAdminT(c);
						return c.html(
							<AdminLayout
								brand={options.brand ?? "Admin"}
								nav={this.buildNav(c, t)}
								resourcesLabel={t("index.resources")}
								lang={c.get("language") ?? "en"}
								breadcrumbs={[
									this.homeBreadcrumb(t),
									{ href: `${this.resolveBasePath()}/resources/${key}`, label: target.label },
									{ label: t("action.change") },
								]}
								userTools={this.resolveUserTools(c)}
								csrfToken={this.csrfToken(c)}
								currentPath={c.req.path}
								t={t}
							>
								<AdminResourceFormView
									basePath={this.resolveBasePath()}
									resourceKey={key}
									label={target.label}
									mode="edit"
									form={binding}
									action={`${this.resolveBasePath()}/resources/${key}/${id}`}
									id={id}
									inlineGroups={inlineGroups}
									csrfToken={this.csrfToken(c)}
									t={t}
								/>
							</AdminLayout>,
							422,
						);
					}

					/**
					 * The row's identity is authoritatively the `id` from the URL, so even if
					 * the primary key column (`target.primaryKey`) ends up in the validated
					 * value, the row's primary key value must not be overwritten; the primary
					 * key is stripped before passing to `update`. Allowlisting non-primary-key
					 * columns is the app's `Form#schema()`'s responsibility (the contract is
					 * that admin does not use a schema that fails to strip unknown keys), so it
					 * is not done here (this stripping is not applied on create, since it would
					 * break tables where admin inputs a natural key such as `code`).
					 */
					await target.model.update(id, withoutKey(parentResult.value, target.primaryKey));
					await persistInlineRows(target, inlinePlans, id);
					await this.recordAudit(c, "resource.update", `${key}/${id}`);

					const t = bindAdminT(c);
					this.flashMessage(c, "success", t("message.changed", { label: target.label }));
					return c.redirect(this.resolveSaveRedirect(body, key, id), 303);
				});

				this.get(`/resources/${key}/:id/delete`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();

					const id = c.req.param("id");
					const row = await target.model.retrieve(id);
					if (!row) return c.notFound();

					const t = bindAdminT(c);
					const basePath = this.resolveBasePath();
					const listHref = `${basePath}/resources/${key}`;
					return c.html(
						<AdminLayout
							brand={options.brand ?? "Admin"}
							nav={this.buildNav(c, t)}
							resourcesLabel={t("index.resources")}
							lang={c.get("language") ?? "en"}
							breadcrumbs={[
								this.homeBreadcrumb(t),
								{ href: listHref, label: target.label },
								{ href: `${listHref}/${encodeURIComponent(id)}`, label: id },
								{ label: t("action.delete") },
							]}
							messages={this.consumeMessages(c)}
							userTools={this.resolveUserTools(c)}
							csrfToken={this.csrfToken(c)}
							currentPath={c.req.path}
							t={t}
						>
							<AdminResourceDeleteView
								basePath={basePath}
								resourceKey={key}
								label={target.label}
								columns={target.columns().map((column) => column.name)}
								row={row}
								primaryKey={target.primaryKey}
								csrfToken={this.csrfToken(c)}
								t={t}
							/>
						</AdminLayout>,
					);
				});

				/**
				 * Requires the confirmation screen's hidden `post=yes` field (a familiar
				 * admin-console's delete-confirmation contract), so a bare `POST` (without
				 * having gone through the confirmation screen first) does not delete the
				 * row; it simply redirects back to the list, same as pressing "No, take me
				 * back".
				 */
				this.post(`/resources/${key}/:id/delete`, async (c) => {
					const target = resolve();
					if (!target) return c.notFound();

					const id = c.req.param("id");
					const existing = await target.model.retrieve(id);
					if (!existing) return c.notFound();

					const listUrl = `${this.resolveBasePath()}/resources/${key}`;
					const body = await c.req.parseBody();
					if (body.post !== "yes") return c.redirect(listUrl, 303);

					await target.model.delete(id);
					await this.recordAudit(c, "resource.delete", `${key}/${id}`);

					const t = bindAdminT(c);
					this.flashMessage(c, "success", t("message.deleted", { label: target.label }));
					return c.redirect(listUrl, 303);
				});
			}
		}
	}
}
