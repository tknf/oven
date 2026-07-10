/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s group delete confirmation screen. A pure JSX component
 * that does not depend on Hono's `Context`, same convention as
 * `admin_accounts_users_delete_view.tsx`.
 *
 * Same two-step delete contract as the users screen: this is reached via a
 * `deletelink` GET (from the list or edit screens) and only performs the
 * actual delete once its `<form method="post">` (embedding the required
 * `post=yes` field) is submitted.
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

export type AdminAccountsGroupsDeleteViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	id: string;
	name: string;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Accounts-group delete confirmation screen body. Renders the target group's summary and the confirm/cancel controls. */
export const AdminAccountsGroupsDeleteView = ({
	basePath,
	id,
	name,
	csrfToken,
	t,
}: AdminAccountsGroupsDeleteViewProps) => {
	const listHref = `${basePath}/accounts/groups`;
	const deleteHref = `${listHref}/${encodeURIComponent(id)}/delete`;

	return (
		<>
			<h2>{t("delete.confirm", { label: name })}</h2>
			<div class="module">
				<dl>
					<dt>{t("accounts.groups.col.name")}</dt>
					<dd>{name}</dd>
				</dl>
			</div>
			<form method="post" action={deleteHref}>
				{csrfToken !== null && (
					<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
				)}
				<input type="hidden" name="post" value="yes" />
				<div class="submit-row">
					<button type="submit" class="deletelink">
						{t("delete.yes")}
					</button>
					<a class="cancel-link" href={listHref}>
						{t("delete.cancel")}
					</a>
				</div>
			</form>
		</>
	);
};
