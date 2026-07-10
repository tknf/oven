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
 * `canDelete` is `true`, the result table is wrapped in a
 * `<form id="changelist-form" method="post">` posting back to this same list URL,
 * with a row-selection checkbox column and an actions bar above the table
 * (`<select name="action">` + `_selected_action` checkboxes + `select_across` +
 * a "Run" submit button). `AdminPanel#wireResources` dispatches on the presence of
 * `action` in the posted body to distinguish this from the create-form POST that
 * targets the same URL.
 *
 * `canCreate`/`canUpdate`/`canDelete` are resolved by `AdminPanel` from both
 * `AdminResource#canWrite()` (whether the resource has a `form()` at all) and
 * the current operator's granted permission set, so an operator who only holds
 * `resource.<key>.view` never sees an Add link, an Edit link, a Delete link, or
 * the bulk-action UI that would otherwise 403 when clicked.
 *
 * The list itself is a numbered, offset-based pagination (`?p=`, 0-based) over
 * `AdminModel#listPage`, with an arbitrary-column sort (`?o=<i>` ascending,
 * `?o=-<i>` descending, `i` indexing `columns` — a familiar admin-console
 * convention) instead of `paginate`'s cursor-only, primary-key-fixed order. Every
 * link that changes sort or a filter resets back to page 0 (`buildListUrl`'s
 * `page` argument); only page links preserve the current page.
 */
import type { AdminFilter } from "./admin_resource.js";
import type { AdminT } from "./admin_catalog.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";

/** The list screen's current sort (a display column index from `columns` + direction), or `null` when unsorted (falls back to the resource's default order). */
export type AdminResourceSort = { index: number; direction: "asc" | "desc" } | null;

/** One page-navigation link within the list screen's date-hierarchy drilldown (see `AdminResource#dateHierarchy`). */
export type AdminDateHierarchyItem = { label: string; href: string };

/**
 * The list screen's date-based drilldown navigation state, built by
 * `AdminPanel` when the resource declares `dateHierarchy()`. `items` lists
 * the next level down (years, months, or days, depending on how far the
 * operator has drilled in); `back` links up one level (absent at the top,
 * year-only level); `current` is set instead of `items` at the bottom (day)
 * level, since there is no level below it to list. Labels are pre-resolved
 * by the panel (including the localized month name), so this view renders
 * them as-is without needing `Context` or a language.
 */
export type AdminDateHierarchyNav = {
	back?: AdminDateHierarchyItem;
	items: AdminDateHierarchyItem[];
	current?: string;
};

/** The subset of list-screen state every generated link (sort/filter/page) needs to reproduce. */
type ListState = {
	query: string;
	activeFilters: Record<string, string | undefined>;
	sort: AdminResourceSort;
};

/**
 * Builds one list screen URL from the current `state` plus `page` and optional
 * sort/filter overrides. Sort and filter links always pass `page: 0` (changing
 * the ordering or a filter returns to the first page); only the paginator's
 * own page links pass the target page number.
 */
const buildListUrl = (
	basePath: string,
	resourceKey: string,
	state: ListState,
	page: number,
	overrides?: {
		filterColumn?: string;
		filterValue?: string;
		sortIndex?: number;
		sortDirection?: "asc" | "desc";
	},
): string => {
	const params = new URLSearchParams();
	if (state.query) params.set("q", state.query);

	for (const [column, value] of Object.entries(state.activeFilters)) {
		const resolved = overrides?.filterColumn === column ? overrides.filterValue : value;
		if (resolved) params.set(column, resolved);
	}

	const sortIndex = overrides?.sortIndex ?? state.sort?.index;
	const sortDirection = overrides?.sortDirection ?? state.sort?.direction;
	if (sortIndex !== undefined) {
		params.set("o", sortDirection === "desc" ? `-${sortIndex}` : String(sortIndex));
	}

	if (page > 0) params.set("p", String(page));

	const qs = params.toString();
	const base = `${basePath}/resources/${resourceKey}`;
	return qs ? `${base}?${qs}` : base;
};

/** Ellipsis marker used by `buildPageRange` to elide long runs of page numbers. */
const PAGE_RANGE_ELLIPSIS = "…";

/**
 * Elides a long page-number list down to the first 2, the last 2, and a window
 * of 3 pages on either side of the current page. Returns `page`-indexed
 * numbers (0-based) interleaved with `PAGE_RANGE_ELLIPSIS` markers wherever a
 * gap is skipped.
 */
const buildPageRange = (
	page: number,
	pageCount: number,
): (number | typeof PAGE_RANGE_ELLIPSIS)[] => {
	const kept = new Set<number>();
	for (let i = 0; i < Math.min(2, pageCount); i++) kept.add(i);
	for (let i = Math.max(0, pageCount - 2); i < pageCount; i++) kept.add(i);
	for (let i = Math.max(0, page - 3); i <= Math.min(pageCount - 1, page + 3); i++) kept.add(i);

	const sorted = [...kept].sort((a, b) => a - b);
	const range: (number | typeof PAGE_RANGE_ELLIPSIS)[] = [];
	let previous: number | null = null;
	for (const current of sorted) {
		if (previous !== null && current - previous > 1) range.push(PAGE_RANGE_ELLIPSIS);
		range.push(current);
		previous = current;
	}
	return range;
};

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
	/** Whether to show the "Add" link (`AdminResource#canWrite()` AND the operator's granted set includes `resource.<key>.create`). */
	canCreate: boolean;
	/** Whether to show each row's Edit link (`AdminResource#canWrite()` AND the operator's granted set includes `resource.<key>.update`). */
	canUpdate: boolean;
	/** Whether to show the row-selection column, each row's Delete link, and the bulk-action UI (`AdminResource#canWrite()` AND the operator's granted set includes `resource.<key>.delete`). */
	canDelete: boolean;
	/** Whether to show the search form (whether `AdminResource#searchColumns()` has at least one entry). */
	searchEnabled: boolean;
	/** Current search term (the `q` query). */
	query: string;
	/** Filterable columns declared by `AdminResource#filters()`. Empty means no sidebar. */
	filters: AdminFilter[];
	/** Currently selected value per filter column (`filters[].column` -> selected value, if any). */
	activeFilters: Record<string, string | undefined>;
	/** Current sort (a `columns` index + direction), or `null` when unsorted (the resource's default order applies). */
	sort: AdminResourceSort;
	/** Current page (0-based, the `?p=` query). */
	page: number;
	/** Total number of pages at the current page size (always at least `1`). */
	pageCount: number;
	/** Total row count matching the current search/filter (`AdminModel#count`), shown near the pagination controls. */
	total: number;
	/**
	 * Date-based drilldown navigation, present only when `AdminResource#dateHierarchy()`
	 * is implemented and at least one row exists to anchor the min/max period on.
	 */
	dateHierarchy?: AdminDateHierarchyNav;
	/** CSRF token embedded into the bulk-action form. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/**
 * Date-hierarchy drilldown nav, shown above the search toolbar when the
 * resource declares `dateHierarchy()`. Renders the "back up one level" link
 * (when present) followed by either the next level's links (`items`) or, at
 * the bottom (day) level, the currently selected day as plain text
 * (`current`). Links are pre-built by `AdminPanel`, so this component only
 * renders the given `label`/`href` pairs.
 */
const DateHierarchyNav = ({
	dateHierarchy,
	t,
}: {
	dateHierarchy: AdminDateHierarchyNav;
	t: AdminT;
}) => (
	<nav class="date-hierarchy" aria-label={t("a11y.dateDrilldown")}>
		<ul>
			{dateHierarchy.back && (
				<li>
					<a href={dateHierarchy.back.href}>{`‹ ${dateHierarchy.back.label}`}</a>
				</li>
			)}
			{dateHierarchy.current !== undefined ? (
				<li>{dateHierarchy.current}</li>
			) : (
				dateHierarchy.items.map((item) => (
					<li>
						<a href={item.href}>{item.label}</a>
					</li>
				))
			)}
		</ul>
	</nav>
);

/**
 * Search form. Not rendered when `searchEnabled` is `false`. Since a GET form
 * only submits its own named fields, the current sort and active filters are
 * carried through as hidden inputs (dropping `p`, so a new search always lands
 * on page 0 — the same "changing the query resets pagination" convention as
 * the sort/filter links). `role="search"` marks the form as a search landmark;
 * the `q` input's visible label is `.visually-hidden` since the submit button
 * text ("Search") already conveys its purpose visually.
 */
const SearchForm = ({
	basePath,
	resourceKey,
	query,
	sort,
	filters,
	activeFilters,
	t,
}: {
	basePath: string;
	resourceKey: string;
	query: string;
	sort: AdminResourceSort;
	filters: AdminFilter[];
	activeFilters: Record<string, string | undefined>;
	t: AdminT;
}) => (
	<div id="toolbar">
		<form role="search" method="get" action={`${basePath}/resources/${resourceKey}`}>
			<label class="visually-hidden" for="admin-search">
				{t("action.search")}
			</label>
			<input type="search" id="admin-search" name="q" value={query} />
			{sort !== null && (
				<input
					type="hidden"
					name="o"
					value={sort.direction === "desc" ? `-${sort.index}` : String(sort.index)}
				/>
			)}
			{filters.map((f) => {
				const value = activeFilters[f.column];
				return value ? <input type="hidden" name={f.column} value={value} /> : null;
			})}
			<button type="submit">{t("action.search")}</button>
		</form>
	</div>
);

/**
 * A row's display name for `aria-label`s (row-selection checkbox, per-row
 * action links): the first display column's stringified value, falling back
 * to the primary key `id` when that column is empty (e.g. `null`).
 */
const rowDisplayName = (row: Record<string, unknown>, columns: string[], id: string): string => {
	const first = columns[0];
	const value = first !== undefined ? stringify(row[first]) : "";
	return value !== "" ? value : id;
};

/**
 * List table body. Renders only the "no matches" message when there are 0
 * rows. Every display column's header is a sort link (`class="sortable
 * column-{name}"`; the active column additionally gets `sorted
 * ascending`/`sorted descending"` and `aria-sort`) built from
 * `state`/`buildListUrl`: clicking an inactive column sorts it ascending,
 * clicking the active column toggles its direction — a single-column sort,
 * matching a familiar admin-console convention (multi-column sort is out of
 * scope here).
 *
 * The table gets a visually-hidden `<caption>` (its accessible name, since
 * there is no visible heading directly above it) and every header cell a
 * `scope="col"`; the first display column of each row is additionally
 * rendered as `<th scope="row">` rather than `<td>`, since it is that row's
 * identifying label. There is no "select all" checkbox — a JS-free page
 * cannot make it do anything, and an inert control mostly confuses assistive
 * technology — so the header's row-selection column is a `.visually-hidden`
 * label instead, keeping the column non-empty for screen readers without
 * implying it's interactive.
 */
const ResourceTable = ({
	basePath,
	resourceKey,
	label,
	columns,
	rows,
	primaryKey,
	canUpdate,
	canDelete,
	state,
	t,
}: {
	basePath: string;
	resourceKey: string;
	label: string;
	columns: string[];
	rows: Record<string, unknown>[];
	primaryKey: string;
	canUpdate: boolean;
	canDelete: boolean;
	state: ListState;
	t: AdminT;
}) => {
	if (rows.length === 0) return <p>{t("resource.empty")}</p>;

	return (
		<div class="module">
			<table>
				<caption class="visually-hidden">{label}</caption>
				<thead>
					<tr>
						{canDelete && (
							<th class="action-checkbox-column" scope="col">
								<span class="visually-hidden">{t("a11y.select")}</span>
							</th>
						)}
						{columns.map((name, index) => {
							const isActive = state.sort !== null && state.sort.index === index;
							const direction = isActive && state.sort ? state.sort.direction : null;
							const nextDirection = direction === "asc" ? "desc" : "asc";
							const classNames = ["sortable", `column-${name}`];
							if (isActive)
								classNames.push("sorted", direction === "asc" ? "ascending" : "descending");
							const href = buildListUrl(basePath, resourceKey, state, 0, {
								sortIndex: index,
								sortDirection: nextDirection,
							});
							const ariaSort = !isActive
								? "none"
								: direction === "asc"
									? "ascending"
									: "descending";
							return (
								<th class={classNames.join(" ")} scope="col" aria-sort={ariaSort}>
									<a href={href} aria-label={t("a11y.sortBy", { column: name })}>
										{name}
										{direction === "asc" ? (
											<span aria-hidden="true"> ▲</span>
										) : direction === "desc" ? (
											<span aria-hidden="true"> ▼</span>
										) : null}
									</a>
								</th>
							);
						})}
						<th scope="col" />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const id = stringify(row[primaryKey]);
						const detailHref = `${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}`;
						const name = rowDisplayName(row, columns, id);
						return (
							<tr>
								{canDelete && (
									<td class="action-checkbox-column">
										<input
											type="checkbox"
											class="action-select"
											name="_selected_action"
											value={id}
											aria-label={t("a11y.selectRow", { name })}
										/>
									</td>
								)}
								{columns.map((columnName, index) =>
									index === 0 ? (
										<th scope="row">{stringify(row[columnName])}</th>
									) : (
										<td>{stringify(row[columnName])}</td>
									),
								)}
								<td>
									<a href={detailHref} aria-label={t("a11y.viewItem", { name })}>
										{t("action.detail")}
									</a>
									{canUpdate && (
										<a href={`${detailHref}/edit`} aria-label={t("a11y.editItem", { name })}>
											{t("action.edit")}
										</a>
									)}
									{canDelete && (
										<a
											class="deletelink"
											href={`${detailHref}/delete`}
											aria-label={t("a11y.deleteItem", { name })}
										>
											{t("action.delete")}
										</a>
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
 * Bulk-action bar shown above the result table when `canDelete` is `true`. The
 * `<select name="action">` currently offers only "delete", alongside a
 * `select_across` field (always posts `"0"` since this list has no "select
 * all matching, across every page" affordance) and an `index` field. Lives
 * inside `changelist-form` alongside the table so its `_selected_action`
 * checkboxes are submitted together.
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
 * declared filter, links the current `q`/sort/other-filters state through and
 * either sets or clears this filter's column, so switching a filter never loses
 * search text, sort, or other active filters. Every link resets to page 0
 * (changing a filter always returns to the first page).
 */
const FilterSidebar = ({
	basePath,
	resourceKey,
	filters,
	activeFilters,
	state,
	t,
}: {
	basePath: string;
	resourceKey: string;
	filters: AdminFilter[];
	activeFilters: Record<string, string | undefined>;
	state: ListState;
	t: AdminT;
}) => (
	<div id="changelist-filter">
		<h2>{t("filter.title")}</h2>
		{filters.map((f) => (
			<>
				<h3>{f.label ?? f.column}</h3>
				<ul>
					<li class={activeFilters[f.column] ? "" : "selected"}>
						<a
							href={buildListUrl(basePath, resourceKey, state, 0, {
								filterColumn: f.column,
								filterValue: undefined,
							})}
						>
							{t("filter.all")}
						</a>
					</li>
					{f.options.map((option) => (
						<li class={activeFilters[f.column] === option.value ? "selected" : ""}>
							<a
								href={buildListUrl(basePath, resourceKey, state, 0, {
									filterColumn: f.column,
									filterValue: option.value,
								})}
							>
								{option.label}
							</a>
						</li>
					))}
				</ul>
			</>
		))}
	</div>
);

/**
 * Numbered pagination + result count, replacing the previous cursor-based
 * "next" link (`PaginationView`). The page-number list only renders when there
 * is more than one page (`pageCount > 1`); the result count is always shown.
 * Page numbers are displayed 1-based (`p + 1`) even though the `?p=` query
 * itself is 0-based, and the current page renders as plain text with
 * `aria-current="page"` rather than a link (mirrors a familiar admin-console's
 * `paginator_number` behavior).
 */
const Paginator = ({
	basePath,
	resourceKey,
	state,
	page,
	pageCount,
	total,
	label,
	t,
}: {
	basePath: string;
	resourceKey: string;
	state: ListState;
	page: number;
	pageCount: number;
	total: number;
	label: string;
	t: AdminT;
}) => (
	<nav class="paginator" aria-label="pagination">
		{pageCount > 1 &&
			buildPageRange(page, pageCount).map((entry) => {
				if (entry === PAGE_RANGE_ELLIPSIS) {
					return <span class="ellipsis">{PAGE_RANGE_ELLIPSIS}</span>;
				}
				if (entry === page) {
					return (
						<span class="this-page" aria-current="page">
							{entry + 1}
						</span>
					);
				}
				return (
					<a
						href={buildListUrl(basePath, resourceKey, state, entry)}
						aria-label={t("a11y.page", { n: entry + 1 })}
					>
						{entry + 1}
					</a>
				);
			})}
		<span class="result-count">
			{total} {label}
		</span>
	</nav>
);

/** Resource list screen body. Renders the heading, new-record link, search form, list table (with a bulk-action form when `canDelete`), numbered pagination + result count, and (when `filters` is non-empty) the filter sidebar. */
export const AdminResourceListView = ({
	basePath,
	resourceKey,
	label,
	columns,
	rows,
	primaryKey,
	canCreate,
	canUpdate,
	canDelete,
	searchEnabled,
	query,
	filters,
	activeFilters,
	sort,
	page,
	pageCount,
	total,
	dateHierarchy,
	csrfToken,
	t,
}: AdminResourceListViewProps) => {
	const listUrl = `${basePath}/resources/${resourceKey}`;
	const state: ListState = { query, activeFilters, sort };
	const table = (
		<ResourceTable
			basePath={basePath}
			resourceKey={resourceKey}
			label={label}
			columns={columns}
			rows={rows}
			primaryKey={primaryKey}
			canUpdate={canUpdate}
			canDelete={canDelete}
			state={state}
			t={t}
		/>
	);

	const results = (
		<>
			{canCreate && (
				<div class="object-tools">
					<a class="addlink" href={`${listUrl}/new`} aria-label={t("a11y.addItem", { label })}>
						{t("action.create")}
					</a>
				</div>
			)}
			{dateHierarchy && <DateHierarchyNav dateHierarchy={dateHierarchy} t={t} />}
			{searchEnabled && (
				<SearchForm
					basePath={basePath}
					resourceKey={resourceKey}
					query={query}
					sort={sort}
					filters={filters}
					activeFilters={activeFilters}
					t={t}
				/>
			)}
			{canDelete && rows.length > 0 ? (
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
			<Paginator
				basePath={basePath}
				resourceKey={resourceKey}
				state={state}
				page={page}
				pageCount={pageCount}
				total={total}
				label={label}
				t={t}
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
						filters={filters}
						activeFilters={activeFilters}
						state={state}
						t={t}
					/>
				</div>
			)}
		</>
	);
};
