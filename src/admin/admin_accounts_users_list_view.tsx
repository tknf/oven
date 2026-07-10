/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s user list. A pure JSX component that does not depend on
 * Hono's `Context`, same convention as `admin_resource_list_view.tsx`.
 *
 * Offset pagination (`?p=`, 0-based) mirrors the resource list's `?p=`
 * convention; both screens share the same `OffsetPaginationView` from
 * `pagination/`, with this screen's own `buildUsersUrl` supplying the
 * (sort/filter-free) URL shape.
 */
import type { AdminT } from "./admin_catalog.js";
import type { AdminAccountsUserRow } from "./admin_types.js";
import { OffsetPaginationView } from "../pagination/index.js";

/** Builds one users-list URL, carrying the current search `query` through and dropping `p` at page 0. */
const buildUsersUrl = (basePath: string, query: string, page: number): string => {
	const params = new URLSearchParams();
	if (query) params.set("q", query);
	if (page > 0) params.set("p", String(page));

	const qs = params.toString();
	const base = `${basePath}/accounts/users`;
	return qs ? `${base}?${qs}` : base;
};

/** Formats an epoch ms column as an ISO string. `null` becomes `"-"` (same convention as `admin_jobs_view.tsx`'s `formatTime`). */
const formatTime = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

export type AdminAccountsUsersListViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	rows: AdminAccountsUserRow[];
	/** Current search term (the `q` query, matched against username/label). */
	query: string;
	/** Current page (0-based, the `?p=` query). */
	page: number;
	/** Total number of pages at the current page size (always at least `1`). */
	pageCount: number;
	/** Total user count matching the current search, shown near the pagination controls. */
	total: number;
	/** Href to the operator-groups list, for the toolbar's cross-link to it. Omitted entirely when `AdminPanelOptions.accounts.groups` is not injected. */
	groupsHref?: string;
	t: AdminT;
};

/** Search form. Carries the current query through a plain GET, always landing on page 0 on submit. */
const SearchForm = ({ basePath, query, t }: { basePath: string; query: string; t: AdminT }) => (
	<div id="toolbar">
		<form role="search" method="get" action={`${basePath}/accounts/users`}>
			<label class="visually-hidden" for="admin-users-search">
				{t("action.search")}
			</label>
			<input type="search" id="admin-users-search" name="q" value={query} />
			<button type="submit">{t("action.search")}</button>
		</form>
	</div>
);

/** User list table. Renders only the "no matches" message when there are 0 rows. */
const UsersTable = ({
	basePath,
	rows,
	t,
}: {
	basePath: string;
	rows: AdminAccountsUserRow[];
	t: AdminT;
}) => {
	if (rows.length === 0) return <p>{t("accounts.users.empty")}</p>;

	return (
		<div class="module">
			<table>
				<caption class="visually-hidden">{t("accounts.users.title")}</caption>
				<thead>
					<tr>
						<th scope="col">{t("accounts.users.col.username")}</th>
						<th scope="col">{t("accounts.users.col.label")}</th>
						<th scope="col">{t("accounts.users.col.active")}</th>
						<th scope="col">{t("accounts.users.col.superuser")}</th>
						<th scope="col">{t("accounts.users.col.lastLogin")}</th>
						<th scope="col" />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const editHref = `${basePath}/accounts/users/${encodeURIComponent(row.id)}/edit`;
						return (
							<tr>
								<th scope="row">{row.username}</th>
								<td>{row.label ?? "-"}</td>
								<td>{row.isActive ? t("settings.enabled") : t("settings.disabled")}</td>
								<td>{row.isSuperuser ? t("settings.enabled") : t("settings.disabled")}</td>
								<td>{formatTime(row.lastLoginAt)}</td>
								<td>
									<a href={editHref} aria-label={t("a11y.editItem", { name: row.username })}>
										{t("action.edit")}
									</a>
									<a
										class="deletelink"
										href={`${basePath}/accounts/users/${encodeURIComponent(row.id)}/delete`}
										aria-label={t("a11y.deleteItem", { name: row.username })}
									>
										{t("action.delete")}
									</a>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
};

/** Accounts-user list screen body. Renders the heading, "add user" link, search form, list table, and numbered pagination + result count. */
export const AdminAccountsUsersListView = ({
	basePath,
	rows,
	query,
	page,
	pageCount,
	total,
	groupsHref,
	t,
}: AdminAccountsUsersListViewProps) => (
	<>
		<h2>{t("accounts.users.title")}</h2>
		<div class="object-tools">
			{groupsHref !== undefined && <a href={groupsHref}>{t("accounts.users.groupsLink")}</a>}
			<a
				class="addlink"
				href={`${basePath}/accounts/users/new`}
				aria-label={t("a11y.addItem", { label: t("accounts.users.singular") })}
			>
				{t("action.create")}
			</a>
		</div>
		<SearchForm basePath={basePath} query={query} t={t} />
		<UsersTable basePath={basePath} rows={rows} t={t} />
		<OffsetPaginationView
			page={page}
			pageCount={pageCount}
			buildUrl={(p) => buildUsersUrl(basePath, query, p)}
			pageLabel={(n) => t("a11y.page", { n })}
			summary={`${total} ${t("accounts.users.title")}`}
			attrs={{ class: "paginator" }}
		/>
	</>
);
