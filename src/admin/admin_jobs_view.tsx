/**
 * `AdminPanel`'s job operations screen. A pure JSX component that does not depend
 * on Hono's `Context` (same convention as `pagination_view.tsx`/`admin_layout.tsx`;
 * does not use `useRequestContext`-style APIs and simply renders the given values).
 *
 * Operations (retry/delete) are completed with native `<form method="post">` and
 * carry no JS. When `csrfToken` (issued by `AdminPanel` only when `panelOptions.csrf`
 * is injected) is non-`null`, a CSRF hidden input (`CSRF_FORM_FIELD_NAME`) is embedded
 * in each form. When not injected, it stays `null` and no hidden input is emitted, as
 * before (backward compatible).
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";
import type { AdminJobRow } from "./admin_types.js";

export type AdminJobsViewProps = {
	/** `AdminPanel`'s mount base path (`AdminPanelOptions.basePath`). Used to build links/forms. */
	basePath: string;
	pending: AdminJobRow[];
	failed: AdminJobRow[];
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Returns a CSRF hidden input only when `csrfToken` is non-`null`. */
const CsrfHiddenInput = ({ csrfToken }: { csrfToken: string | null }) =>
	csrfToken === null ? null : <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />;

/** Formats an epoch ms column as an ISO string. `null` becomes `"-"` as-is. */
const formatTime = (ms: number | null): string => (ms === null ? "-" : new Date(ms).toISOString());

/** Pending jobs list table. Appends a delete form at the end of each row. */
const PendingJobsTable = ({
	basePath,
	pending,
	csrfToken,
	t,
}: {
	basePath: string;
	pending: AdminJobRow[];
	csrfToken: string | null;
	t: AdminT;
}) => {
	if (pending.length === 0) return <p>{t("jobs.emptyPending")}</p>;

	return (
		<div class="module">
			<table>
				<caption class="visually-hidden">{t("jobs.pending")}</caption>
				<thead>
					<tr>
						<th scope="col">ID</th>
						<th scope="col">{t("col.name")}</th>
						<th scope="col">{t("jobs.col.priority")}</th>
						<th scope="col">{t("jobs.col.runAt")}</th>
						<th scope="col">{t("jobs.col.attempts")}</th>
						<th scope="col" />
					</tr>
				</thead>
				<tbody>
					{pending.map((row) => (
						<tr>
							<th scope="row">{row.id}</th>
							<td>{row.name}</td>
							<td>{row.priority}</td>
							<td>{formatTime(row.runAt)}</td>
							<td>{row.attempts}</td>
							<td>
								<form
									method="post"
									action={`${basePath}/jobs/${encodeURIComponent(row.id)}/delete`}
								>
									<CsrfHiddenInput csrfToken={csrfToken} />
									<button type="submit" aria-label={t("a11y.deleteItem", { name: row.id })}>
										{t("action.delete")}
									</button>
								</form>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

/** Failed jobs list table. Appends retry and delete forms at the end of each row. */
const FailedJobsTable = ({
	basePath,
	failed,
	csrfToken,
	t,
}: {
	basePath: string;
	failed: AdminJobRow[];
	csrfToken: string | null;
	t: AdminT;
}) => {
	if (failed.length === 0) return <p>{t("jobs.emptyFailed")}</p>;

	return (
		<div class="module">
			<table>
				<caption class="visually-hidden">{t("jobs.failed")}</caption>
				<thead>
					<tr>
						<th scope="col">ID</th>
						<th scope="col">{t("col.name")}</th>
						<th scope="col">{t("jobs.col.attempts")}</th>
						<th scope="col">{t("jobs.col.failedAt")}</th>
						<th scope="col">{t("jobs.col.error")}</th>
						<th scope="col" />
					</tr>
				</thead>
				<tbody>
					{failed.map((row) => (
						<tr>
							<th scope="row">{row.id}</th>
							<td>{row.name}</td>
							<td>{row.attempts}</td>
							<td>{formatTime(row.failedAt)}</td>
							<td>{row.lastError ?? "-"}</td>
							<td>
								<form method="post" action={`${basePath}/jobs/${encodeURIComponent(row.id)}/retry`}>
									<CsrfHiddenInput csrfToken={csrfToken} />
									<button type="submit" aria-label={`${t("action.retry")} ${row.id}`}>
										{t("action.retry")}
									</button>
								</form>
								<form
									method="post"
									action={`${basePath}/jobs/${encodeURIComponent(row.id)}/delete`}
								>
									<CsrfHiddenInput csrfToken={csrfToken} />
									<button type="submit" aria-label={t("a11y.deleteItem", { name: row.id })}>
										{t("action.delete")}
									</button>
								</form>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};

/** Job operations screen body. Renders the pending list and failed list tables. */
export const AdminJobsView = ({ basePath, pending, failed, csrfToken, t }: AdminJobsViewProps) => (
	<>
		<h2>{t("jobs.title")}</h2>
		<h3>{t("jobs.pending")}</h3>
		<PendingJobsTable basePath={basePath} pending={pending} csrfToken={csrfToken} t={t} />
		<h3>{t("jobs.failed")}</h3>
		<FailedJobsTable basePath={basePath} failed={failed} csrfToken={csrfToken} t={t} />
	</>
);
