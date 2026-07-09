/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * create/edit form screen. A pure JSX component that does not depend on Hono's
 * `Context`, same convention as `admin_jobs_view.tsx`. Delegates rendering the form
 * body to `FormView` in `form/form_field.tsx`.
 *
 * Passes `csrfToken` (issued by `AdminPanel` only when `panelOptions.csrf` is
 * injected) straight through to `FormView` (which automatically inserts a CSRF
 * hidden input when non-`null`). Delete is a two-step flow: the delete link here
 * only navigates to the delete confirmation screen (`AdminResourceDeleteView`),
 * which is where the actual `<form method="post">` submission happens.
 */
import type { FormBinding } from "../form/form.js";
import { FormView } from "../form/form_field.js";
import type { AdminT } from "./admin_catalog.js";

export type AdminResourceFormViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	mode: "new" | "edit";
	form: FormBinding<string>;
	action: string;
	/** Primary key value of the target row when `mode === "edit"` (used to build the delete link). */
	id?: string;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Delete link to the confirmation screen, rendered only when `mode === "edit"` and `id` is present. */
const DeleteLink = ({
	basePath,
	resourceKey,
	id,
	t,
}: {
	basePath: string;
	resourceKey: string;
	id: string;
	t: AdminT;
}) => (
	<a
		class="deletelink"
		href={`${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}/delete`}
	>
		{t("action.delete")}
	</a>
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
			<div class="submit-row">
				<button type="submit" name="_save" value="1" class="default">
					{t("action.save")}
				</button>
				<button type="submit" name="_addanother" value="1">
					{t("action.saveAddAnother")}
				</button>
				<button type="submit" name="_continue" value="1">
					{t("action.saveContinue")}
				</button>
			</div>
		</FormView>
		{mode === "edit" && id !== undefined && (
			<DeleteLink basePath={basePath} resourceKey={resourceKey} id={id} t={t} />
		)}
		<a href={`${basePath}/resources/${resourceKey}`}>{t("action.backToList")}</a>
	</>
);
