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
 *
 * ## Inline child relations (`inlineGroups`)
 * When `AdminResource#inlines()` is implemented, `AdminPanel` builds one
 * `AdminInlineGroup` per declared inline (see its constructing side,
 * `admin_panel.tsx`'s `buildInlineGroups`) and passes them here as
 * `inlineGroups`. Each group renders as a fixed-row tabular block
 * (`.inline-group` > `.tabular-inline`) inside the `<form>`, right before the
 * submit-row, so a row's fields post together with the parent's own fields.
 * This step (D-i1) only declares and renders the markup; the parent's
 * create/update handlers do not yet read or persist inline rows.
 */
import type { FormBinding } from "../form/form.js";
import { FormField, FormView } from "../form/form_field.js";
import type { AdminT } from "./admin_catalog.js";

/** One rendered row of an `AdminInlineGroup`'s table (see the module JSDoc "Inline child relations"). */
export type AdminInlineGroupRow = {
	/** 0-based row index within this inline (used to build this row's field-name prefix). */
	index: number;
	/** The child row's bound form fields, from `inline.form().bind({ prefix: `${key}-${index}`, ... })`. */
	binding: FormBinding<string>;
	/** The existing child row's primary key value. Absent for a blank (not-yet-persisted) row. */
	pk?: string;
};

/** One inline group to render inside the parent's create/edit form (built by `admin_panel.tsx`'s `buildInlineGroups`). */
export type AdminInlineGroup = {
	key: string;
	label: string;
	/** Column header labels, in the same order as each row's `binding.visibleFields()`. */
	headers: string[];
	rows: AdminInlineGroupRow[];
	/** Total rendered row count (existing rows + blank rows), mirrored into the `${key}-__total` hidden input. */
	total: number;
};

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
	/** Inline child relations to render inside the form, before the submit-row. Empty/omitted when the resource declares none. */
	inlineGroups?: AdminInlineGroup[];
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

/** One inline group's fixed-row table (see the module JSDoc "Inline child relations"). */
const InlineGroupView = ({ group, t }: { group: AdminInlineGroup; t: AdminT }) => (
	<div class="inline-group">
		<h2>{group.label}</h2>
		<input type="hidden" name={`${group.key}-__total`} value={String(group.total)} />
		<table class="tabular-inline">
			<thead>
				<tr>
					{group.headers.map((header) => (
						<th>{header}</th>
					))}
					<th>{t("action.delete")}</th>
				</tr>
			</thead>
			<tbody>
				{group.rows.map((row) => (
					<tr>
						{row.binding.visibleFields().map((field) => (
							<td>
								<FormField field={field} />
							</td>
						))}
						<td>
							{row.binding.hiddenFields().map((field) => (
								<FormField field={field} />
							))}
							{row.pk !== undefined && (
								<>
									<input type="hidden" name={`${group.key}-${row.index}-__pk`} value={row.pk} />
									<input type="checkbox" name={`${group.key}-${row.index}-__delete`} />
								</>
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
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
	inlineGroups,
	csrfToken,
	t,
}: AdminResourceFormViewProps) => (
	<>
		<h2>
			{mode === "new" ? t("resource.newTitle", { label }) : t("resource.editTitle", { label })}
		</h2>
		<FormView form={form} action={action} method="post" csrfToken={csrfToken}>
			{inlineGroups?.map((group) => (
				<InlineGroupView group={group} t={t} />
			))}
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
