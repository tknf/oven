/**
 * `AdminPanel`'s resource CRUD section's bulk-delete confirmation screen. Reached
 * from the list screen's actions bar (`AdminResourceListView`) after choosing
 * "Delete selected {label}" with one or more rows checked. A pure JSX component
 * that does not depend on Hono's `Context`, same convention as
 * `admin_resource_delete_view.tsx`.
 *
 * Deletion is a two-step flow, same contract as the single-row confirmation: this
 * screen lists the selected primary key values and carries them, plus `action=delete`
 * and `post=yes`, as hidden fields; the actual delete only happens once this
 * `<form method="post">` is submitted. There is no JS; "No, take me back" is a plain
 * link back to the resource's list.
 */
import type { AdminT } from "./admin_catalog.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";

export type AdminResourceBulkDeleteViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	/** Primary key values selected on the list screen (`_selected_action`). */
	selected: string[];
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Resource bulk-delete confirmation screen body. Lists the selected rows and renders the confirm/cancel controls. */
export const AdminResourceBulkDeleteView = ({
	basePath,
	resourceKey,
	label,
	selected,
	csrfToken,
	t,
}: AdminResourceBulkDeleteViewProps) => {
	const listHref = `${basePath}/resources/${resourceKey}`;

	return (
		<>
			<p>{t("delete.confirmSelected", { label })}</p>
			<div class="module">
				<ul>
					{selected.map((id) => (
						<li>{id}</li>
					))}
				</ul>
			</div>
			<form method="post" action={listHref}>
				{csrfToken !== null && (
					<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
				)}
				<input type="hidden" name="post" value="yes" />
				<input type="hidden" name="action" value="delete" />
				{selected.map((id) => (
					<input type="hidden" name="_selected_action" value={id} />
				))}
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
