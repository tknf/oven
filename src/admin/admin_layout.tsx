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
import type { PropsWithChildren } from "hono/jsx";
import { ADMIN_CSS } from "./admin_styles.js";

/** A single navigation item (link target and label). */
export type AdminNavItem = {
	href: string;
	label: string;
};

export type AdminLayoutProps = PropsWithChildren<{
	/** Brand name shown in the screen header. */
	brand: string;
	/** List of nav links to wired sections (unwired sections are not included). */
	nav: AdminNavItem[];
	/** `<html lang>` attribute value; the resolved admin UI language (`c.get("language") ?? "en"`). */
	lang: string;
}>;

/** Renders the nav link list. An empty array leaves just the `<ul>` (no section wired). */
const AdminNav = ({ nav }: { nav: AdminNavItem[] }) => (
	<nav>
		<ul>
			{nav.map((item) => (
				<li>
					<a href={item.href}>{item.label}</a>
				</li>
			))}
		</ul>
	</nav>
);

/** Self-contained HTML document wrapping the whole admin screen. `children` renders inside `<main>`. */
export const AdminLayout = ({ brand, nav, children, lang }: AdminLayoutProps) => (
	<html lang={lang}>
		<head>
			<meta charset="utf-8" />
			<title>{brand}</title>
			<style>{ADMIN_CSS}</style>
		</head>
		<body>
			<header>
				<h1>{brand}</h1>
				<AdminNav nav={nav} />
			</header>
			<main>{children}</main>
		</body>
	</html>
);
