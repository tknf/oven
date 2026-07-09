/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * create/edit form screen. A pure JSX component that does not depend on Hono's
 * `Context`, same convention as `admin_jobs_view.tsx`. Delegates rendering the form
 * body to `FormView` in `form/form_field.tsx`.
 *
 * Passes `csrfToken` (issued by `AdminPanel` only when `panelOptions.csrf` is
 * injected) straight through to `FormView` (which automatically inserts a CSRF
 * hidden input when non-`null`). The delete form also embeds the same token as a
 * CSRF hidden input. When not injected, it stays `null` and no hidden input is
 * emitted, as before (backward compatible).
 */
import type { FormBinding } from "../form/form.js";
import { FormView } from "../form/form_field.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

export type AdminResourceFormViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	mode: "new" | "edit";
	form: FormBinding<string>;
	action: string;
	/** Primary key value of the target row when `mode === "edit"` (used to build the delete form). */
	id?: string;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Delete form, rendered only when `mode === "edit"` and `id` is present. */
const DeleteForm = ({
	basePath,
	resourceKey,
	id,
	csrfToken,
	t,
}: {
	basePath: string;
	resourceKey: string;
	id: string;
	csrfToken: string | null;
	t: AdminT;
}) => (
	<form
		method="post"
		action={`${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}/delete`}
	>
		{csrfToken !== null && <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />}
		<button type="submit">{t("action.delete")}</button>
	</form>
);

/** Resource create/edit form screen body. */
export const AdminResourceFormView = ({
	basePath,
	resourceKey,
	label,
	mode,
	form,
	action,
	id,
	csrfToken,
	t,
}: AdminResourceFormViewProps) => (
	<>
		<h2>
			{mode === "new" ? t("resource.newTitle", { label }) : t("resource.editTitle", { label })}
		</h2>
		<FormView form={form} action={action} method="post" csrfToken={csrfToken}>
			<button type="submit">{t("action.save")}</button>
		</FormView>
		{mode === "edit" && id !== undefined && (
			<DeleteForm
				basePath={basePath}
				resourceKey={resourceKey}
				id={id}
				csrfToken={csrfToken}
				t={t}
			/>
		)}
		<a href={`${basePath}/resources/${resourceKey}`}>{t("action.backToList")}</a>
	</>
);
