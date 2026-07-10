/**
 * `AdminPanel`'s resource CRUD section (`AdminResource` from `admin_resource.ts`)'s
 * show screen. A pure JSX component that does not depend on Hono's `Context`, same
 * convention as `admin_jobs_view.tsx`.
 *
 * Delete is a two-step flow: the link here only navigates to the delete
 * confirmation screen (`AdminResourceDeleteView`), which is where the actual
 * `<form method="post">` submission happens.
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
	/** Whether to show the edit link (`AdminResource#canWrite()` AND the operator's granted set includes `resource.<key>.update`). */
	canUpdate: boolean;
	/** Whether to show the delete link (`AdminResource#canWrite()` AND the operator's granted set includes `resource.<key>.delete`). */
	canDelete: boolean;
	t: AdminT;
};

/** Resource show screen body. Renders a column name/value definition list, and (per `canUpdate`/`canDelete`) an edit link and/or delete link. */
export const AdminResourceShowView = ({
	basePath,
	resourceKey,
	label,
	columns,
	row,
	primaryKey,
	canUpdate,
	canDelete,
	t,
}: AdminResourceShowViewProps) => {
	const id = stringify(row[primaryKey]);
	const detailHref = `${basePath}/resources/${resourceKey}/${encodeURIComponent(id)}`;

	return (
		<>
			<h2>{t("resource.showTitle", { label })}</h2>
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
			{canUpdate && (
				<a
					class="button"
					href={`${detailHref}/edit`}
					aria-label={t("a11y.editItem", { name: label })}
				>
					{t("action.edit")}
				</a>
			)}
			{canDelete && (
				<a
					class="deletelink"
					href={`${detailHref}/delete`}
					aria-label={t("a11y.deleteItem", { name: label })}
				>
					{t("action.delete")}
				</a>
			)}
			<a href={`${basePath}/resources/${resourceKey}`}>{t("action.backToList")}</a>
		</>
	);
};
