/**
 * `AdminPanel`'s superuser-only operator accounts screen (`admin_panel.tsx`'s
 * `wireAccounts`)'s user create/edit form. A pure JSX component that does not
 * depend on Hono's `Context`, same convention as `admin_resource_form_view.tsx`.
 *
 * Unlike the resource CRUD screen's form, this one is not built from `Form`/
 * `FormBinding` (operator accounts are not an `AdminResource`): the fields are
 * fixed (username/password/label/active/superuser/permissions/groups), so they
 * are plain HTML inputs assembled directly here, following the same widget
 * markup as `form/form_field.tsx`'s `checkbox`/`checkbox-group` (a `<fieldset>`
 * + `<legend>` wrapping one checkbox per option) for visual and accessibility
 * consistency with the resource forms.
 *
 * `mode: "new"` includes the password field inline (an account cannot be
 * created without one); `mode: "edit"` omits it and instead renders a second,
 * separate `<form>` for changing the password (`admin_panel.tsx`'s
 * `POST /accounts/users/:id/password`), plus the delete link into the
 * confirmation screen (`AdminAccountsUsersDeleteView`).
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

/** One rendered checkbox option in the permissions/groups checkbox groups below: a submittable `value`, a display `label`, and whether it starts checked. */
export type AdminAccountsCheckboxOption = { value: string; label: string; checked: boolean };

/** The form's editable profile fields (shared shape between a blank `"new"` form and a prefilled `"edit"` one). */
export type AdminAccountsUserFormValues = {
	username: string;
	label: string;
	isActive: boolean;
	isSuperuser: boolean;
};

export type AdminAccountsUsersFormViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	mode: "new" | "edit";
	/** Main profile form's `action` target. */
	action: string;
	/** The target user's id. Present (and required for the password form/delete link) only in `mode: "edit"`. */
	id?: string;
	values: AdminAccountsUserFormValues;
	permissionOptions: AdminAccountsCheckboxOption[];
	/**
	 * Permission strings the user already holds but that do not correspond to
	 * any checkbox above (e.g. granted by an app no longer wiring that
	 * resource). Displayed as a note; kept as-is on save (see `admin_panel.tsx`'s
	 * `wireAccounts`), never editable through this screen.
	 */
	unknownPermissions: string[];
	/** Group membership checkboxes. Omitted entirely when `AdminPanelOptions.accounts.groups` is not injected. */
	groupOptions?: AdminAccountsCheckboxOption[];
	/** General error from the last submission of the main profile form (e.g. a duplicate username). `null` when there is none to show. */
	error: string | null;
	/** Error from the last submission of the password form. `null` when there is none to show. */
	passwordError: string | null;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Returns a CSRF hidden input only when `csrfToken` is non-`null`. */
const CsrfHiddenInput = ({ csrfToken }: { csrfToken: string | null }) =>
	csrfToken === null ? null : <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />;

/**
 * One checkbox-group `<fieldset>`, matching `form/form_field.tsx`'s `checkbox-group`
 * markup. Exported for reuse by `admin_accounts_groups_form_view.tsx`, whose
 * permissions checkbox group needs the exact same markup.
 */
export const CheckboxGroup = ({
	legend,
	name,
	options,
}: {
	legend: string;
	name: string;
	options: AdminAccountsCheckboxOption[];
}) => (
	<fieldset>
		<legend>{legend}</legend>
		{options.map((option) => {
			const optionId = `id_${name}-${option.value}`;
			return (
				<div>
					<input
						type="checkbox"
						id={optionId}
						name={name}
						value={option.value}
						checked={option.checked}
					/>
					<label for={optionId}>{option.label}</label>
				</div>
			);
		})}
	</fieldset>
);

/** The separate password-change form, rendered only in `mode: "edit"`. */
const ChangePasswordForm = ({
	basePath,
	id,
	passwordError,
	csrfToken,
	t,
}: {
	basePath: string;
	id: string;
	passwordError: string | null;
	csrfToken: string | null;
	t: AdminT;
}) => (
	<section class="module">
		<h3>{t("accounts.users.changePassword")}</h3>
		{passwordError !== null && (
			<p class="errornote" role="alert">
				{passwordError}
			</p>
		)}
		<form method="post" action={`${basePath}/accounts/users/${encodeURIComponent(id)}/password`}>
			<CsrfHiddenInput csrfToken={csrfToken} />
			<div class="form-row">
				<label for="id_new_password">{t("accounts.users.field.newPassword")}</label>
				<input
					type="password"
					id="id_new_password"
					name="password"
					autocomplete="new-password"
					required
				/>
			</div>
			<div class="submit-row">
				<button type="submit">{t("accounts.users.changePassword")}</button>
			</div>
		</form>
	</section>
);

/** Accounts-user create/edit form screen body. */
export const AdminAccountsUsersFormView = ({
	basePath,
	mode,
	action,
	id,
	values,
	permissionOptions,
	unknownPermissions,
	groupOptions,
	error,
	passwordError,
	csrfToken,
	t,
}: AdminAccountsUsersFormViewProps) => {
	const listHref = `${basePath}/accounts/users`;

	return (
		<>
			<h2>{mode === "new" ? t("accounts.users.newTitle") : t("accounts.users.editTitle")}</h2>
			{error !== null && (
				<p class="errornote" role="alert">
					{error}
				</p>
			)}
			<form method="post" action={action}>
				<CsrfHiddenInput csrfToken={csrfToken} />
				<div class="form-row">
					<label for="id_username">{t("accounts.users.field.username")}</label>
					<input type="text" id="id_username" name="username" value={values.username} required />
				</div>
				{mode === "new" && (
					<div class="form-row">
						<label for="id_password">{t("accounts.users.field.password")}</label>
						<input
							type="password"
							id="id_password"
							name="password"
							autocomplete="new-password"
							required
						/>
					</div>
				)}
				<div class="form-row">
					<label for="id_label">{t("accounts.users.field.label")}</label>
					<input type="text" id="id_label" name="label" value={values.label} />
				</div>
				<div class="form-row">
					<input type="checkbox" id="id_isActive" name="isActive" checked={values.isActive} />
					<label for="id_isActive">{t("accounts.users.field.active")}</label>
				</div>
				<div class="form-row">
					<input
						type="checkbox"
						id="id_isSuperuser"
						name="isSuperuser"
						checked={values.isSuperuser}
					/>
					<label for="id_isSuperuser">{t("accounts.users.field.superuser")}</label>
				</div>
				<CheckboxGroup
					legend={t("accounts.users.field.permissions")}
					name="permissions"
					options={permissionOptions}
				/>
				{unknownPermissions.length > 0 && (
					<p class="help-text">
						{t("accounts.users.unknownPermissions", { list: unknownPermissions.join(", ") })}
					</p>
				)}
				{groupOptions !== undefined && (
					<CheckboxGroup
						legend={t("accounts.users.field.groups")}
						name="groups"
						options={groupOptions}
					/>
				)}
				<div class="submit-row">
					<button type="submit" class="default">
						{t("action.save")}
					</button>
				</div>
			</form>
			{mode === "edit" && id !== undefined && (
				<>
					<ChangePasswordForm
						basePath={basePath}
						id={id}
						passwordError={passwordError}
						csrfToken={csrfToken}
						t={t}
					/>
					<a
						class="deletelink"
						href={`${listHref}/${encodeURIComponent(id)}/delete`}
						aria-label={t("a11y.deleteItem", { name: values.username })}
					>
						{t("action.delete")}
					</a>
				</>
			)}
			<a href={listHref}>{t("action.backToList")}</a>
		</>
	);
};
