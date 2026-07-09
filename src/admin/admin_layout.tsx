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
import type { AdminMessage } from "./admin_types.js";
import { ADMIN_CSS } from "./admin_styles.js";

/** A single navigation item (link target and label). */
export type AdminNavItem = {
	href: string;
	label: string;
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
}>;

/** Renders the nav link list. An empty array leaves just the `<ul>` (no section wired). */
const AdminNav = ({ nav }: { nav: AdminNavItem[] }) => (
	<nav id="nav-header">
		<ul>
			{nav.map((item) => (
				<li>
					<a href={item.href}>{item.label}</a>
				</li>
			))}
		</ul>
	</nav>
);

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
	children,
	lang,
	breadcrumbs,
	messages,
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
				<AdminNav nav={nav} />
			</header>
			<AdminBreadcrumbs breadcrumbs={breadcrumbs ?? []} />
			<AdminMessages messages={messages ?? []} />
			<main id="content">{children}</main>
		</body>
	</html>
);
