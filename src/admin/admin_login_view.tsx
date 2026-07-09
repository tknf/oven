/**
 * `AdminPanel`'s built-in login screen (`admin_panel.tsx`'s `/login` route). Unlike
 * every other admin screen, this one does **not** render inside `AdminLayout` — a
 * logged-out visitor has no header user-tools or sidebar nav to show, so this is
 * its own self-contained HTML document (same `<style>{raw(ADMIN_CSS)}</style>`
 * inlining convention as `AdminLayout`, kept in sync manually since there is no
 * shared base to factor the `<head>` into without adding one just for this).
 *
 * Pure JSX that does not depend on Hono's `Context`, same convention as
 * `AdminResourceDeleteView` — the caller (`AdminPanel`) resolves everything
 * (brand, csrf token, `next`, translated strings) up front and passes it in.
 */
import { raw } from "hono/html";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminT } from "./admin_catalog.js";
import { ADMIN_CSS } from "./admin_styles.js";

export type AdminLoginViewProps = {
	/** Brand name shown in the page title and card header. */
	brand: string;
	/** This panel's mount base path (`AdminPanelOptions.basePath`). Used to build the form's `action`. */
	basePath: string;
	/** CSRF token. When `null`, no hidden input is emitted (same convention as every other admin form). */
	csrfToken: string | null;
	/** Validated `?next=`/submitted `next` redirect target (already confined to `basePath` by the caller). */
	next: string;
	/** Whether the previous submission failed authentication (renders the `auth.invalid` error note). */
	error: boolean;
	/** The submitted username, re-shown on a failed attempt. Never pre-filled with the password. */
	username: string;
	lang: string;
	t: AdminT;
};

/** Self-contained HTML document for the login screen (no `AdminLayout`; see the module JSDoc). */
export const AdminLoginView = ({
	brand,
	basePath,
	csrfToken,
	next,
	error,
	username,
	lang,
	t,
}: AdminLoginViewProps) => (
	<html lang={lang}>
		<head>
			<meta charset="utf-8" />
			<title>
				{brand} — {t("auth.logIn")}
			</title>
			{/* ADMIN_CSS is a developer-authored static constant (no user input flows into
			 * it), so it is inserted verbatim via `raw()`, same as `AdminLayout`. */}
			<style>{raw(ADMIN_CSS)}</style>
		</head>
		<body class="login">
			<form class="login-form" method="post" action={`${basePath}/login`}>
				<h1>{brand}</h1>
				<div class="login-body">
					{error ? <p class="errornote">{t("auth.invalid")}</p> : null}
					{csrfToken !== null ? (
						<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
					) : null}
					<input type="hidden" name="next" value={next} />
					<div class="form-row">
						<label for="id_username">{t("auth.username")}</label>
						<input type="text" id="id_username" name="username" value={username} required />
					</div>
					<div class="form-row">
						<label for="id_password">{t("auth.password")}</label>
						<input type="password" id="id_password" name="password" required />
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
