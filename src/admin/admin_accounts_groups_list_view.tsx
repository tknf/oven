/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s group list. A pure JSX component that does not depend on
 * Hono's `Context`, same convention as `admin_accounts_users_list_view.tsx`.
 *
 * Unlike the users list, this screen has neither search nor pagination
 * (`AdminAccountsGroups#listGroups` always returns every group, and the
 * expected group count is small), so it renders the full set in one table.
 */
import { parseStoredPermissions } from "./admin_permissions.js";
import type { AdminT } from "./admin_catalog.js";
import type { AdminAccountsGroupRow } from "./admin_types.js";

export type AdminAccountsGroupsListViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	rows: AdminAccountsGroupRow[];
	/** Href to the operator-users list, for the toolbar's cross-link back to it. */
	usersHref: string;
	t: AdminT;
};

/** Group list table. Renders only the "no matches" message when there are 0 rows. */
const GroupsTable = ({
	basePath,
	rows,
	t,
}: {
	basePath: string;
	rows: AdminAccountsGroupRow[];
	t: AdminT;
}) => {
	if (rows.length === 0) return <p>{t("accounts.groups.empty")}</p>;

	return (
		<div class="module">
			<table>
				<caption class="visually-hidden">{t("accounts.groups.title")}</caption>
				<thead>
					<tr>
						<th scope="col">{t("accounts.groups.col.name")}</th>
						<th scope="col">{t("accounts.groups.col.permissionCount")}</th>
						<th scope="col" />
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => {
						const editHref = `${basePath}/accounts/groups/${encodeURIComponent(row.id)}/edit`;
						return (
							<tr>
								<th scope="row">{row.name}</th>
								<td>{parseStoredPermissions(row.permissions).length}</td>
								<td>
									<a href={editHref} aria-label={t("a11y.editItem", { name: row.name })}>
										{t("action.edit")}
									</a>
									<a
										class="deletelink"
										href={`${basePath}/accounts/groups/${encodeURIComponent(row.id)}/delete`}
										aria-label={t("a11y.deleteItem", { name: row.name })}
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

/** Accounts-group list screen body. Renders the heading, "add group" link, cross-link to the users list, and the group table. */
export const AdminAccountsGroupsListView = ({
	basePath,
	rows,
	usersHref,
	t,
}: AdminAccountsGroupsListViewProps) => (
	<>
		<h2>{t("accounts.groups.title")}</h2>
		<div class="object-tools">
			<a href={usersHref}>{t("accounts.groups.usersLink")}</a>
			<a
				class="addlink"
				href={`${basePath}/accounts/groups/new`}
				aria-label={t("a11y.addItem", { label: t("accounts.groups.singular") })}
			>
				{t("action.create")}
			</a>
		</div>
		<GroupsTable basePath={basePath} rows={rows} t={t} />
	</>
);
