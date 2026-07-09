/**
 * Self-contained HTML document layout used by `AdminPanel` (`admin_panel.tsx`)'s
 * dashboard and other screens. Pure JSX that does not depend on `useRequestContext`
 * and does not require Hono's `Context` (same convention as `pagination_view.tsx`/
 * `form_field.tsx`).
 *
 * Takes the self-contained approach of passing directly to the response, as in
 * `c.html(<AdminLayout .../>)` (analogous to how `MailPreviewHandler` assembles an
 * HTML document from a raw string, except this one assembles it via JSX).
 * `RouteHandler#layout()` (the `ContextRenderer` via `jsxRenderer`) presupposes
 * app-side wiring, so it is not used for this layout, which is meant to be
 * self-contained within admin.
 */
import { raw } from "hono/html";
import type { PropsWithChildren } from "hono/jsx";
import { CSRF_FORM_FIELD_NAME } from "../security/csrf.js";
import type { AdminMessage, AdminUserTools } from "./admin_types.js";
import { ADMIN_CSS } from "./admin_styles.js";

/** A single navigation item (link target and label). */
export type AdminNavItem = {
	href: string;
	label: string;
	/**
	 * Which group of the sidebar the item belongs to: `"section"` for the
	 * dashboard and built-in screens (jobs/settings/audit), `"resource"` for a
	 * mounted `AdminResource`. Defaults to `"section"` when omitted, so callers
	 * that don't care about grouping (e.g. existing tests) still work.
	 */
	group?: "section" | "resource";
};

/**
 * A single breadcrumb entry. `href` is omitted for the current page (rendered as
 * plain text instead of a link).
 */
export type AdminBreadcrumb = {
	href?: string;
	label: string;
};

export type AdminLayoutProps = PropsWithChildren<{
	/** Brand name shown in the screen header. */
	brand: string;
	/** List of nav links to wired sections (unwired sections are not included). */
	nav: AdminNavItem[];
	/** Heading text shown above the sidebar's resource links, when `nav` contains any `group: "resource"` items. */
	resourcesLabel: string;
	/** `<html lang>` attribute value; the resolved admin UI language (`c.get("language") ?? "en"`). */
	lang: string;
	/** Breadcrumb trail shown below the header. Omitted or empty renders nothing (backward compatible). */
	breadcrumbs?: AdminBreadcrumb[];
	/**
	 * Flash messages consumed from the session for this request (e.g. "The Publisher
	 * was added successfully."). Omitted or empty renders nothing; only populated when
	 * `AdminPanelOptions.session` is injected.
	 */
	messages?: AdminMessage[];
	/**
	 * Header user-tools block content (greeting + links, e.g. "View site" /
	 * "Log out"). Omitted renders nothing; only populated when
	 * `AdminPanelOptions.userTools` is injected.
	 */
	userTools?: AdminUserTools;
	/**
	 * CSRF token to embed as a hidden input in any `method: "post"` user-tools
	 * link's form (e.g. logout). `null`/omitted emits no hidden input, same
	 * convention as every other form in the panel.
	 */
	csrfToken?: string | null;
}>;

/**
 * Renders the left-hand sidebar nav (Django admin's `#nav-sidebar` equivalent):
 * a vertical link list, no JS. Items are split into two groups by
 * `AdminNavItem#group` — `"section"` items (dashboard, jobs, settings, audit)
 * render first, followed by a `resourcesLabel` heading and the `"resource"`
 * items (one per mounted `AdminResource`), if any. This keeps the sidebar
 * scrollable rather than growing a header sideways as resources are added.
 */
const AdminNav = ({ nav, resourcesLabel }: { nav: AdminNavItem[]; resourcesLabel: string }) => {
	const sections = nav.filter((item) => (item.group ?? "section") === "section");
	const resources = nav.filter((item) => item.group === "resource");

	return (
		<nav id="nav-sidebar" aria-label="Sections">
			<ul>
				{sections.map((item) => (
					<li>
						<a href={item.href}>{item.label}</a>
					</li>
				))}
			</ul>
			{resources.length > 0 ? (
				<>
					<h2>{resourcesLabel}</h2>
					<ul>
						{resources.map((item) => (
							<li>
								<a href={item.href}>{item.label}</a>
							</li>
						))}
					</ul>
				</>
			) : null}
		</nav>
	);
};

/** Renders the breadcrumb trail. Renders nothing when `breadcrumbs` is empty or omitted. */
const AdminBreadcrumbs = ({ breadcrumbs }: { breadcrumbs: AdminBreadcrumb[] }) => {
	if (breadcrumbs.length === 0) return null;

	return (
		<div id="breadcrumbs">
			{breadcrumbs.map((crumb, index) => (
				<>
					{index > 0 ? " › " : null}
					{crumb.href ? <a href={crumb.href}>{crumb.label}</a> : crumb.label}
				</>
			))}
		</div>
	);
};

/**
 * Renders the header's user-tools block (Django admin's `#user-tools`
 * equivalent: a greeting plus links such as "View site" / "Log out").
 * Renders nothing when `userTools` is `undefined` (not injected), so the
 * block is fully backward compatible.
 */
const AdminUserToolsBar = ({
	userTools,
	csrfToken,
}: {
	userTools: AdminUserTools | undefined;
	csrfToken: string | null | undefined;
}) => {
	if (!userTools) return null;

	const links = userTools.links ?? [];
	return (
		<div id="user-tools">
			{userTools.greeting ? <>{userTools.greeting} </> : null}
			{links.map((link, index) => (
				<>
					{index > 0 ? " / " : null}
					{link.method === "post" ? (
						<form method="post" action={link.href}>
							{csrfToken ? (
								<input type="hidden" name={CSRF_FORM_FIELD_NAME} value={csrfToken} />
							) : null}
							<button type="submit">{link.label}</button>
						</form>
					) : (
						<a href={link.href}>{link.label}</a>
					)}
				</>
			))}
		</div>
	);
};

/** Renders the flash message list (Django admin's `messagelist`). Renders nothing when `messages` is empty. */
const AdminMessages = ({ messages }: { messages: AdminMessage[] }) => {
	if (messages.length === 0) return null;

	return (
		<ul class="messagelist">
			{messages.map((message) => (
				<li class={message.level}>{message.text}</li>
			))}
		</ul>
	);
};

/** Self-contained HTML document wrapping the whole admin screen. `children` renders inside `<main>`. */
export const AdminLayout = ({
	brand,
	nav,
	resourcesLabel,
	children,
	lang,
	breadcrumbs,
	messages,
	userTools,
	csrfToken,
}: AdminLayoutProps) => (
	<html lang={lang}>
		<head>
			<meta charset="utf-8" />
			<title>{brand}</title>
			{/* ADMIN_CSS is a developer-authored static constant (no user input flows into
			 * it), so it is inserted verbatim via `raw()` instead of `{ADMIN_CSS}`, which
			 * would HTML-escape the double quotes inside CSS selectors/values and break
			 * the rules that use them (e.g. `nav[aria-label="pagination"]`). */}
			<style>{raw(ADMIN_CSS)}</style>
		</head>
		<body>
			<header id="header">
				<div id="branding">
					<h1>{brand}</h1>
				</div>
				<AdminUserToolsBar userTools={userTools} csrfToken={csrfToken} />
			</header>
			<AdminBreadcrumbs breadcrumbs={breadcrumbs ?? []} />
			<div class="main" id="main">
				<AdminNav nav={nav} resourcesLabel={resourcesLabel} />
				<main id="content">
					<AdminMessages messages={messages ?? []} />
					{children}
				</main>
			</div>
		</body>
	</html>
);
