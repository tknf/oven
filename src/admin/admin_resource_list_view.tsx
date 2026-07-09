/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * list screen. A pure JSX component that does not depend on Hono's `Context`, same
 * convention as `admin_jobs_view.tsx`/`pagination_view.tsx` (does not use
 * `useRequestContext`-style APIs and simply renders the given values).
 *
 * Operations (delete) are completed with native `<form method="post">` and carry no
 * JS. When `csrfToken` (issued by `AdminPanel` only when `panelOptions.csrf` is
 * injected) is non-`null`, a CSRF hidden input (`CSRF_FORM_FIELD_NAME`) is embedded
 * in the delete form. When not injected, it stays `null` and no hidden input is
 * emitted, as before (backward compatible).
 */
import { PaginationView } from "../pagination/pagination_view.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

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
	/** Whether to show create/edit/delete links/forms (`AdminResource#canWrite()`). */
	canWrite: boolean;
	/** Whether to show the search form (whether `AdminResource#searchColumns()` has at least one entry). */
	searchEnabled: boolean;
	/** Current search term (the `q` query). */
	query: string;
	nextCursor: string | null;
	hasMore: boolean;
	/** CSRF token. When `null`, no hidden input is emitted in the delete form. */
	csrfToken: string | null;
	t: AdminT;
};

/** Returns a CSRF hidden input only when `csrfToken` is non-`null`. */
const CsrfHiddenInput = ({ csrfToken }: { csrfToken: string | null }) =>
	csrfToken === null ? null : <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />;

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
	<form method="get" action={`${basePath}/resources/${resourceKey}`}>
		<input type="search" name="q" value={query} />
		<button type="submit">{t("action.search")}</button>
	</form>
);

/** List table body. Renders only the "no matches" message when there are 0 rows. */
const ResourceTable = ({
	basePath,
	resourceKey,
	columns,
	rows,
	primaryKey,
	canWrite,
	csrfToken,
	t,
}: {
	basePath: string;
	resourceKey: string;
	columns: string[];
	rows: Record<string, unknown>[];
	primaryKey: string;
	canWrite: boolean;
	csrfToken: string | null;
	t: AdminT;
}) => {
	if (rows.length === 0) return <p>{t("resource.empty")}</p>;

	return (
		<table>
			<thead>
				<tr>
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
							{columns.map((name) => (
								<td>{stringify(row[name])}</td>
							))}
							<td>
								<a href={detailHref}>{t("action.detail")}</a>
								{canWrite && (
									<>
										<a href={`${detailHref}/edit`}>{t("action.edit")}</a>
										<form method="post" action={`${detailHref}/delete`}>
											<CsrfHiddenInput csrfToken={csrfToken} />
											<button type="submit">{t("action.delete")}</button>
										</form>
									</>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
};

/** Resource list screen body. Renders the heading, new-record link, search form, list table, and pagination. */
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
	nextCursor,
	hasMore,
	csrfToken,
	t,
}: AdminResourceListViewProps) => (
	<>
		<h2>{label}</h2>
		{canWrite && <a href={`${basePath}/resources/${resourceKey}/new`}>{t("action.create")}</a>}
		{searchEnabled && (
			<SearchForm basePath={basePath} resourceKey={resourceKey} query={query} t={t} />
		)}
		<ResourceTable
			basePath={basePath}
			resourceKey={resourceKey}
			columns={columns}
			rows={rows}
			primaryKey={primaryKey}
			canWrite={canWrite}
			csrfToken={csrfToken}
			t={t}
		/>
		<PaginationView
			nextCursor={nextCursor}
			hasMore={hasMore}
			label={t("action.next")}
			buildUrl={(cursor) =>
				`${basePath}/resources/${resourceKey}?cursor=${encodeURIComponent(String(cursor))}${
					query ? `&q=${encodeURIComponent(query)}` : ""
				}`
			}
		/>
	</>
);
