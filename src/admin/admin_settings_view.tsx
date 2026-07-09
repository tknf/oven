/**
 * `AdminPanel`'s settings screen. A pure JSX component that does not depend on
 * Hono's `Context`, displaying a `FeatureFlags` toggle list and a `MaintenanceMode`
 * toggle (same convention as `admin_jobs_view.tsx`).
 *
 * The flag names to display are explicitly enumerated by the app via
 * `AdminPanelOptions.settings.featureFlags.names` (since `KeyValueStore` cannot be
 * enumerated). When `maintenance` is `null` (`MaintenanceMode` not injected), that
 * whole section is not rendered.
 *
 * When `csrfToken` (issued by `AdminPanel` only when `panelOptions.csrf` is
 * injected) is non-`null`, a CSRF hidden input (`CSRF_FORM_FIELD_NAME`) is embedded
 * in each form. When not injected, it stays `null` and no hidden input is emitted,
 * as before (backward compatible).
 */
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";

export type AdminSettingsViewProps = {
	basePath: string;
	flags: { name: string; enabled: boolean }[];
	maintenance: { enabled: boolean } | null;
	/** CSRF token. When `null`, no hidden input is emitted. */
	csrfToken: string | null;
	t: AdminT;
};

/** Returns a CSRF hidden input only when `csrfToken` is non-`null`. */
const CsrfHiddenInput = ({ csrfToken }: { csrfToken: string | null }) =>
	csrfToken === null ? null : <input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />;

/** Flag list. Each row shows the current value and a toggle form. */
const FeatureFlagsSection = ({
	basePath,
	flags,
	csrfToken,
	t,
}: {
	basePath: string;
	flags: { name: string; enabled: boolean }[];
	csrfToken: string | null;
	t: AdminT;
}) => (
	<section>
		<h3>{t("settings.flags")}</h3>
		{flags.length === 0 ? (
			<p>{t("settings.flagsEmpty")}</p>
		) : (
			<ul>
				{flags.map((flag) => (
					<li>
						{flag.name}: {flag.enabled ? t("settings.enabled") : t("settings.disabled")}
						<form
							method="post"
							action={`${basePath}/settings/flags/${encodeURIComponent(flag.name)}`}
						>
							<CsrfHiddenInput csrfToken={csrfToken} />
							<input type="hidden" name="op" value={flag.enabled ? "disable" : "enable"} />
							<button type="submit">
								{flag.enabled ? t("settings.disable") : t("settings.enable")}
							</button>
						</form>
					</li>
				))}
			</ul>
		)}
	</section>
);

/** Maintenance mode toggle. Renders nothing when `maintenance` is `null`. */
const MaintenanceModeSection = ({
	basePath,
	maintenance,
	csrfToken,
	t,
}: {
	basePath: string;
	maintenance: { enabled: boolean } | null;
	csrfToken: string | null;
	t: AdminT;
}) => {
	if (maintenance === null) return null;

	return (
		<section>
			<h3>{t("settings.maintenance")}</h3>
			<p>
				{t("settings.current")}{" "}
				{maintenance.enabled ? t("settings.maintOn") : t("settings.maintOff")}
			</p>
			<form method="post" action={`${basePath}/settings/maintenance`}>
				<CsrfHiddenInput csrfToken={csrfToken} />
				<input type="hidden" name="op" value={maintenance.enabled ? "disable" : "enable"} />
				<button type="submit">
					{maintenance.enabled ? t("settings.maintDisable") : t("settings.maintEnable")}
				</button>
			</form>
		</section>
	);
};

/** Settings screen body. Renders the feature flags section and maintenance mode section. */
export const AdminSettingsView = ({
	basePath,
	flags,
	maintenance,
	csrfToken,
	t,
}: AdminSettingsViewProps) => (
	<>
		<h2>{t("nav.settings")}</h2>
		<FeatureFlagsSection basePath={basePath} flags={flags} csrfToken={csrfToken} t={t} />
		<MaintenanceModeSection
			basePath={basePath}
			maintenance={maintenance}
			csrfToken={csrfToken}
			t={t}
		/>
	</>
);
