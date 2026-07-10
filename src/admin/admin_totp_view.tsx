/**
 * `AdminPanel`'s built-in TOTP second-login-step screen (`admin_panel.tsx`'s
 * `/login/totp` route), reached after a correct username/password when the
 * authenticated user has TOTP enrolled (`AdminAccountsUsers#verifyTotp`; see
 * `admin_types.ts`). Mirrors `admin_login_view.tsx` exactly: a self-contained
 * HTML document (not `AdminLayout` — there is still no logged-in identity at
 * this point), same `<style>{raw(ADMIN_CSS)}</style>` inlining convention.
 *
 * Pure JSX that does not depend on Hono's `Context`, same convention as
 * `AdminLoginView` — the caller (`AdminPanel`) resolves everything up front.
 */
import { raw } from "hono/html";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";
import { ADMIN_CSS } from "./admin_styles.js";

export type AdminTotpViewProps = {
	/** Brand name shown in the page title and card header. */
	brand: string;
	/** This panel's mount base path (`AdminPanelOptions.basePath`). Used to build the form's `action`. */
	basePath: string;
	/** CSRF token. When `null`, no hidden input is emitted (same convention as every other admin form). */
	csrfToken: string | null;
	/**
	 * Whether and why the previous submission did not pass this step:
	 * `"invalid"` for a code that does not verify (renders `auth.totpInvalid`),
	 * `"tooManyAttempts"` for the `rateLimiter` gate rejecting the submission
	 * before `verifyTotp` even runs (renders `auth.tooManyAttempts`; see
	 * `AdminPanel`'s `POST /login/totp`), or `false` for a fresh, error-free
	 * screen.
	 */
	error: false | "invalid" | "tooManyAttempts";
	lang: string;
	t: AdminT;
};

/** Self-contained HTML document for the TOTP second-login-step screen (no `AdminLayout`; see the module JSDoc). */
export const AdminTotpView = ({
	brand,
	basePath,
	csrfToken,
	error,
	lang,
	t,
}: AdminTotpViewProps) => (
	<html lang={lang}>
		<head>
			<meta charset="utf-8" />
			<title>
				{brand} — {t("auth.totpTitle")}
			</title>
			{/* ADMIN_CSS is a developer-authored static constant (no user input flows into
			 * it), so it is inserted verbatim via `raw()`, same as `AdminLoginView`. */}
			<style>{raw(ADMIN_CSS)}</style>
		</head>
		<body class="login">
			<form class="login-form" method="post" action={`${basePath}/login/totp`}>
				<h1>{brand}</h1>
				<div class="login-body">
					{error === "invalid" ? <p class="errornote">{t("auth.totpInvalid")}</p> : null}
					{error === "tooManyAttempts" ? (
						<p class="errornote">{t("auth.tooManyAttempts")}</p>
					) : null}
					{csrfToken !== null ? (
						<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
					) : null}
					<div class="form-row">
						<label for="id_totp_code">{t("auth.totpCode")}</label>
						<input
							type="text"
							id="id_totp_code"
							name="code"
							autocomplete="one-time-code"
							inputmode="numeric"
							required
						/>
					</div>
					<div class="submit-row">
						<button type="submit" class="default">
							{t("auth.logIn")}
						</button>
					</div>
				</div>
			</form>
		</body>
	</html>
);
