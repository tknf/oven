/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s group create/edit form. A pure JSX component that does not
 * depend on Hono's `Context`, same convention as
 * `admin_accounts_users_form_view.tsx`.
 *
 * Like the users form, a group is not an `AdminResource`, so its fields
 * (name/permissions) are plain HTML inputs rather than built from `Form`/
 * `FormBinding`. The permission checkbox group reuses the same
 * `AdminAccountsCheckboxOption` shape and `<fieldset>`/`<legend>` markup as the
 * users form for visual and accessibility consistency.
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import { CheckboxGroup } from "./admin_accounts_users_form_view.js";
import type { AdminAccountsCheckboxOption } from "./admin_accounts_users_form_view.js";
import type { AdminT } from "./admin_catalog.js";

/** The form's editable fields (shared shape between a blank `"new"` form and a prefilled `"edit"` one). */
export type AdminAccountsGroupFormValues = { name: string };

export type AdminAccountsGroupsFormViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	mode: "new" | "edit";
	/** Form's `action` target. */
	action: string;
	/** The target group's id. Present (and required for the delete link) only in `mode: "edit"`. */
	id?: string;
	values: AdminAccountsGroupFormValues;
	permissionOptions: AdminAccountsCheckboxOption[];
	/**
	 * Permission strings the group already holds but that do not correspond to
	 * any checkbox above (e.g. granted by an app no longer wiring that
	 * resource). Displayed as a note; kept as-is on save (see `admin_panel.tsx`'s
	 * `wireAccountsGroups`), never editable through this screen.
	 */
	unknownPermissions: string[];
	/** General error from the last submission (e.g. a duplicate or empty name). `null` when there is none to show. */
	error: string | null;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Returns a CSRF hidden input only when `csrfToken` is non-`null`. Same convention as `admin_accounts_users_form_view.tsx`. */
const CsrfHiddenInput = ({ csrfToken }: { csrfToken: string | null }) =>
	csrfToken === null ? null : <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />;

/** Accounts-group create/edit form screen body. */
export const AdminAccountsGroupsFormView = ({
	basePath,
	mode,
	action,
	id,
	values,
	permissionOptions,
	unknownPermissions,
	error,
	csrfToken,
	t,
}: AdminAccountsGroupsFormViewProps) => {
	const listHref = `${basePath}/accounts/groups`;

	return (
		<>
			<h2>{mode === "new" ? t("accounts.groups.newTitle") : t("accounts.groups.editTitle")}</h2>
			{error !== null && (
				<p class="errornote" role="alert">
					{error}
				</p>
			)}
			<form method="post" action={action}>
				<CsrfHiddenInput csrfToken={csrfToken} />
				<div class="form-row">
					<label for="id_name">{t("accounts.groups.field.name")}</label>
					<input type="text" id="id_name" name="name" value={values.name} required />
				</div>
				<CheckboxGroup
					legend={t("accounts.groups.field.permissions")}
					name="permissions"
					options={permissionOptions}
				/>
				{unknownPermissions.length > 0 && (
					<p class="help-text">
						{t("accounts.groups.unknownPermissions", { list: unknownPermissions.join(", ") })}
					</p>
				)}
				<div class="submit-row">
					<button type="submit" class="default">
						{t("action.save")}
					</button>
				</div>
			</form>
			{mode === "edit" && id !== undefined && (
				<a
					class="deletelink"
					href={`${listHref}/${encodeURIComponent(id)}/delete`}
					aria-label={t("a11y.deleteItem", { name: values.name })}
				>
					{t("action.delete")}
				</a>
			)}
			<a href={listHref}>{t("action.backToList")}</a>
		</>
	);
};
