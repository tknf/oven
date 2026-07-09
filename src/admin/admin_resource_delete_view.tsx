/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * delete confirmation screen. A pure JSX component that does not depend on Hono's
 * `Context`, same convention as `admin_resource_show_view.tsx`.
 *
 * Deletion is a two-step flow: this screen is reached via a `deletelink` GET (from
 * the list/show/edit screens), summarizes the target row the same way
 * `AdminResourceShowView` does, and only performs the actual delete once its
 * `<form method="post">` (embedding the required `post=yes` field, mirroring a
 * familiar admin-console's delete-confirmation contract) is submitted. There is no
 * JS; the "No, take me back" control is a plain link back to the resource's list.
 */
import type { AdminT } from "./admin_catalog.js";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";

/**
 * Converts one `Record<string, unknown>` value into a display string. Same behavior
 * as `stringify` in `admin_resource_show_view.tsx` (a small duplication to keep this
 * view a self-contained, Hono-independent component).
 */
const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	return "";
};

export type AdminResourceDeleteViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	/** Display column names (`AdminResource#columns()`'s column names; display order). */
	columns: string[];
	row: Record<string, unknown>;
	primaryKey: string;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Resource delete confirmation screen body. Renders the object summary and the confirm/cancel controls. */
export const AdminResourceDeleteView = ({
	basePath,
	resourceKey,
	label,
	columns,
	row,
	primaryKey,
	csrfToken,
	t,
}: AdminResourceDeleteViewProps) => {
	const id = stringify(row[primaryKey]);
	const listHref = `${basePath}/resources/${resourceKey}`;
	const deleteHref = `${listHref}/${encodeURIComponent(id)}/delete`;

	return (
		<>
			<h2>{t("delete.confirm", { label })}</h2>
			<div class="module">
				<dl>
					{columns.map((name) => (
						<>
							<dt>{name}</dt>
							<dd>{stringify(row[name])}</dd>
						</>
					))}
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
