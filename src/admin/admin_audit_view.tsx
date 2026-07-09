/**
 * `AdminPanel`'s audit log viewing screen. Lists `AuditLog#list` query results
 * with a filter form for actor/action/target. A pure JSX component that does not
 * depend on Hono's `Context` (same convention as `admin_jobs_view.tsx`).
 */
import type { AdminT } from "./admin_catalog.js";
import type { AdminAuditRow } from "./admin_types.js";

export type AdminAuditViewProps = {
	basePath: string;
	rows: AdminAuditRow[];
	filter: { actor?: string; action?: string; target?: string };
	t: AdminT;
};

/** Filter form. Prefills each input's `value` with the current `filter` values. */
const AuditFilterForm = ({
	basePath,
	filter,
	t,
}: {
	basePath: string;
	filter: { actor?: string; action?: string; target?: string };
	t: AdminT;
}) => (
	<div id="toolbar">
		<form method="get" action={`${basePath}/audit`}>
			<label>
				actor
				<input type="text" name="actor" value={filter.actor ?? ""} />
			</label>
			<label>
				action
				<input type="text" name="action" value={filter.action ?? ""} />
			</label>
			<label>
				target
				<input type="text" name="target" value={filter.target ?? ""} />
			</label>
			<button type="submit">{t("action.filter")}</button>
		</form>
	</div>
);

/** Audit log list table. Shows a "no matching audit logs" message when empty. */
const AuditRowsTable = ({ rows, t }: { rows: AdminAuditRow[]; t: AdminT }) => {
	if (rows.length === 0) return <p>{t("audit.empty")}</p>;

	return (
		<div class="module">
			<table>
				<thead>
					<tr>
						<th>{t("audit.col.time")}</th>
						<th>actor</th>
						<th>action</th>
						<th>target</th>
						<th>{t("audit.col.changes")}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr>
							<td>{new Date(row.createdAt).toISOString()}</td>
							<td>{row.actor}</td>
							<td>{row.action}</td>
							<td>{row.target}</td>
							<td>{row.changes ?? ""}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

/** Audit log screen body. Renders the filter form and the list table. */
export const AdminAuditView = ({ basePath, rows, filter, t }: AdminAuditViewProps) => (
	<>
		<h2>{t("nav.audit")}</h2>
		<AuditFilterForm basePath={basePath} filter={filter} t={t} />
		<AuditRowsTable rows={rows} t={t} />
	</>
);
