/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * list screen. A pure JSX component that does not depend on Hono's `Context`, same
 * convention as `admin_jobs_view.tsx`/`pagination_view.tsx` (does not use
 * `useRequestContext`-style APIs and simply renders the given values).
 *
 * Per-row delete is a two-step flow: the per-row link here only navigates to the
 * delete confirmation screen (`AdminResourceDeleteView`), which is where the actual
 * `<form method="post">` submission happens.
 *
 * Bulk delete follows the same two-step contract, familiar from other admin
 * consoles' "select rows, choose an action, run, then confirm" flow: when
 * `canWrite` is `true`, the result table is wrapped in a
 * `<form id="changelist-form" method="post">` posting back to this same list URL,
 * with a row-selection checkbox column and an actions bar above the table
 * (`<select name="action">` + `_selected_action` checkboxes + `select_across` +
 * a "Run" submit button). `AdminPanel#wireResources` dispatches on the presence of
 * `action` in the posted body to distinguish this from the create-form POST that
 * targets the same URL.
 */
import { PaginationView } from "../pagination/pagination_view.js";
import type { AdminFilter } from "./admin_resource.js";
import type { AdminT } from "./admin_catalog.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";

/**
 * Converts one `Record<string, unknown>` cell value into a display string. Since
 * `String(unknown)` can produce `"[object Object]"` when passed an object, only
 * string/number/bigint/boolean are converted; anything else (object, null,
 * undefined, etc.) becomes an empty string (same behavior as `stringify` in
 * `admin_panel.tsx`; a small duplication to keep this view a self-contained,
 * Hono-independent component).
 */
const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	return "";
};

export type AdminResourceListViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	/** Display column names (`AdminResource#columns()`'s column names; display order). */
	columns: string[];
	rows: Record<string, unknown>[];
	primaryKey: string;
	/** Whether to show create/edit/delete links/forms and the bulk-action UI (`AdminResource#canWrite()`). */
	canWrite: boolean;
	/** Whether to show the search form (whether `AdminResource#searchColumns()` has at least one entry). */
	searchEnabled: boolean;
	/** Current search term (the `q` query). */
	query: string;
	/** Filterable columns declared by `AdminResource#filters()`. Empty means no sidebar. */
	filters: AdminFilter[];
	/** Currently selected value per filter column (`filters[].column` -> selected value, if any). */
	activeFilters: Record<string, string | undefined>;
	nextCursor: string | null;
	hasMore: boolean;
	/** Total row count matching the current search/filter (`AdminModel#count`), shown near the pagination controls. */
	total: number;
	/** CSRF token embedded into the bulk-action form. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Search form. Not rendered when `searchEnabled` is `false`. */
const SearchForm = ({
	basePath,
	resourceKey,
	query,
	t,
}: {
	basePath: string;
	resourceKey: string;
	query: string;
	t: AdminT;
}) => (
	<div id="toolbar">
		<form method="get" action={`${basePath}/resources/${resourceKey}`}>
			<input type="search" name="q" value={query} />
			<button type="submit">{t("action.search")}</button>
		</form>
	</div>
);

/** List table body. Renders only the "no matches" message when there are 0 rows. */
const ResourceTable = ({
	basePath,
	resourceKey,
	columns,
	rows,
	primaryKey,
	canWrite,
	t,
}: {
	basePath: string;
	resourceKey: string;
	columns: string[];
	rows: Record<string, unknown>[];
	primaryKey: string;
	canWrite: boolean;
	t: AdminT;
}) => {
	if (rows.length === 0) return <p>{t("resource.empty")}</p>;

	return (
		<div class="module">
			<table>
				<thead>
					<tr>
						{canWrite && (
							<th class="action-checkbox-column">
								<input type="checkbox" id="action-toggle" />
							</th>
						)}
						{columns.map((name) => (
							<th>{name}</th>
						))}
						<th />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const id = stringify(row[primaryKey]);
						const detailHref = `${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}`;
						return (
							<tr>
								{canWrite && (
									<td class="action-checkbox-column">
										<input
											type="checkbox"
											class="action-select"
											name="_selected_action"
											value={id}
										/>
									</td>
								)}
								{columns.map((name) => (
									<td>{stringify(row[name])}</td>
								))}
								<td>
									<a href={detailHref}>{t("action.detail")}</a>
									{canWrite && (
										<>
											<a href={`${detailHref}/edit`}>{t("action.edit")}</a>
											<a class="deletelink" href={`${detailHref}/delete`}>
												{t("action.delete")}
											</a>
										</>
									)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
};

/**
 * Bulk-action bar shown above the result table when `canWrite` is `true`. The
 * `<select name="action">` currently offers only "delete" (Django admin's
 * `_selected_action`/`action`/`select_across`/`index` contract; `select_across`
 * always posts `"0"` since this list has no "select all matching, across every
 * page" affordance). Lives inside `changelist-form` alongside the table so its
 * `_selected_action` checkboxes are submitted together.
 */
const ActionsBar = ({ label, t }: { label: string; t: AdminT }) => (
	<div class="actions">
		<label>
			{t("action.actionLabel")}
			<select name="action">
				<option value="">---------</option>
				<option value="delete">{t("action.deleteSelected", { label })}</option>
			</select>
		</label>
		<input type="hidden" name="select_across" value="0" class="select-across" />
		<button type="submit" class="button" name="index" value="0">
			{t("action.run")}
		</button>
	</div>
);

/**
 * Filter sidebar shown next to the results when `filters` is non-empty. For each
 * declared filter, links `q`/the other filters' current selections through and
 * either sets or clears this filter's column, so switching a filter never loses
 * search text or other active filters. `cursor` is deliberately not carried over
 * (changing a filter always returns to the first page).
 */
const FilterSidebar = ({
	basePath,
	resourceKey,
	query,
	filters,
	activeFilters,
	t,
}: {
	basePath: string;
	resourceKey: string;
	query: string;
	filters: AdminFilter[];
	activeFilters: Record<string, string | undefined>;
	t: AdminT;
}) => {
	const buildHref = (column: string, value: string | undefined): string => {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		for (const f of filters) {
			const v = f.column === column ? value : activeFilters[f.column];
			if (v) params.set(f.column, v);
		}
		const qs = params.toString();
		const base = `${basePath}/resources/${resourceKey}`;
		return qs ? `${base}?${qs}` : base;
	};

	return (
		<div id="changelist-filter">
			<h2>{t("filter.title")}</h2>
			{filters.map((f) => (
				<>
					<h3>{f.label ?? f.column}</h3>
					<ul>
						<li class={activeFilters[f.column] ? "" : "selected"}>
							<a href={buildHref(f.column, undefined)}>{t("filter.all")}</a>
						</li>
						{f.options.map((option) => (
							<li class={activeFilters[f.column] === option.value ? "selected" : ""}>
								<a href={buildHref(f.column, option.value)}>{option.label}</a>
							</li>
						))}
					</ul>
				</>
			))}
		</div>
	);
};

/** Resource list screen body. Renders the heading, new-record link, search form, list table (with a bulk-action form when `canWrite`), result count, pagination, and (when `filters` is non-empty) the filter sidebar. */
export const AdminResourceListView = ({
	basePath,
	resourceKey,
	label,
	columns,
	rows,
	primaryKey,
	canWrite,
	searchEnabled,
	query,
	filters,
	activeFilters,
	nextCursor,
	hasMore,
	total,
	csrfToken,
	t,
}: AdminResourceListViewProps) => {
	const listUrl = `${basePath}/resources/${resourceKey}`;
	const table = (
		<ResourceTable
			basePath={basePath}
			resourceKey={resourceKey}
			columns={columns}
			rows={rows}
			primaryKey={primaryKey}
			canWrite={canWrite}
			t={t}
		/>
	);

	const results = (
		<>
			{canWrite && (
				<div class="object-tools">
					<a class="addlink" href={`${listUrl}/new`}>
						{t("action.create")}
					</a>
				</div>
			)}
			{searchEnabled && (
				<SearchForm basePath={basePath} resourceKey={resourceKey} query={query} t={t} />
			)}
			{canWrite && rows.length > 0 ? (
				<form id="changelist-form" method="post" action={listUrl}>
					{csrfToken !== null && (
						<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
					)}
					<ActionsBar label={label} t={t} />
					{table}
				</form>
			) : (
				table
			)}
			<p class="result-count">
				{total} {label}
			</p>
			<PaginationView
				nextCursor={nextCursor}
				hasMore={hasMore}
				label={t("action.next")}
				buildUrl={(cursor) =>
					`${listUrl}?cursor=${encodeURIComponent(String(cursor))}${
						query ? `&q=${encodeURIComponent(query)}` : ""
					}`
				}
			/>
		</>
	);

	return (
		<>
			<h2>{label}</h2>
			{filters.length === 0 ? (
				results
			) : (
				<div class="change-list">
					<div class="results-wrap">{results}</div>
					<FilterSidebar
						basePath={basePath}
						resourceKey={resourceKey}
						query={query}
						filters={filters}
						activeFilters={activeFilters}
						t={t}
					/>
				</div>
			)}
		</>
	);
};
