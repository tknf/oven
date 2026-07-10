/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s user delete confirmation screen. A pure JSX component
 * that does not depend on Hono's `Context`, same convention as
 * `admin_resource_delete_view.tsx`.
 *
 * Same two-step delete contract as the resource screen: this is reached via a
 * `deletelink` GET (from the list or edit screens) and only performs the
 * actual delete once its `<form method="post">` (embedding the required
 * `post=yes` field) is submitted.
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

export type AdminAccountsUsersDeleteViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	id: string;
	username: string;
	label: string | null;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Accounts-user delete confirmation screen body. Renders the target user's summary and the confirm/cancel controls. */
export const AdminAccountsUsersDeleteView = ({
	basePath,
	id,
	username,
	label,
	csrfToken,
	t,
}: AdminAccountsUsersDeleteViewProps) => {
	const listHref = `${basePath}/accounts/users`;
	const deleteHref = `${listHref}/${encodeURIComponent(id)}/delete`;

	return (
		<>
			<h2>{t("delete.confirm", { label: username })}</h2>
			<div class="module">
				<dl>
					<dt>{t("accounts.users.col.username")}</dt>
					<dd>{username}</dd>
					<dt>{t("accounts.users.col.label")}</dt>
					<dd>{label ?? "-"}</dd>
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
