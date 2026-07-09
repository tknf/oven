/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * show screen. A pure JSX component that does not depend on Hono's `Context`, same
 * convention as `admin_jobs_view.tsx`.
 *
 * Operations (delete) are completed with native `<form method="post">` and carry no
 * JS (CSRF/SecureHeaders are not added here, being the upstream app's responsibility).
 */

import type { AdminT } from "./admin_catalog.js";

/**
 * Converts one `Record<string, unknown>` value into a display string. Same behavior
 * as `stringify` in `admin_resource_list_view.tsx` (a small duplication to keep this
 * view a self-contained, Hono-independent component).
 */
const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	return "";
};

export type AdminResourceShowViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	resourceKey: string;
	label: string;
	/** Display column names (`AdminResource#columns()`'s column names; display order). */
	columns: string[];
	row: Record<string, unknown>;
	primaryKey: string;
	/** Whether to show edit/delete links/forms (`AdminResource#canWrite()`). */
	canWrite: boolean;
	t: AdminT;
};

/** Resource show screen body. Renders a column name/value definition list, and if writable, an edit link and delete form. */
export const AdminResourceShowView = ({
	basePath,
	resourceKey,
	label,
	columns,
	row,
	primaryKey,
	canWrite,
	t,
}: AdminResourceShowViewProps) => {
	const id = stringify(row[primaryKey]);
	const detailHref = `${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}`;

	return (
		<>
			<h2>{t("resource.showTitle", { label })}</h2>
			<dl>
				{columns.map((name) => (
					<>
						<dt>{name}</dt>
						<dd>{stringify(row[name])}</dd>
					</>
				))}
			</dl>
			{canWrite && (
				<>
					<a href={`${detailHref}/edit`}>{t("action.edit")}</a>
					<form method="post" action={`${detailHref}/delete`}>
						<button type="submit">{t("action.delete")}</button>
					</form>
				</>
			)}
			<a href={`${basePath}/resources/${resourceKey}`}>{t("action.backToList")}</a>
		</>
	);
};
