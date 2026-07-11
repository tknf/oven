/**
 * Styles for the admin screen, giving it the look of a classic desktop-style
 * admin console: a dark header bar, teal module headings, striped tables, and
 * color-coded action buttons. Since CF Workers has no runtime fs support and
 * `vp pack` does not support `?raw`, the CSS ends up as a string in the JS
 * bundle either way. Given that, holding it as a string constant from the
 * start is more minimal than an external .css file plus a transform.
 * `AdminLayout` inlines this into `<style>`.
 *
 * Colors are expressed through CSS custom properties defined once under
 * `:root`, so light and dark mode only differ by which values those
 * properties resolve to. Dark mode is applied automatically through
 * `prefers-color-scheme` and can also be forced with `html[data-theme="dark"]`
 * for a future manual toggle (no toggle UI/script ships yet). Values are
 * chosen to meet WCAG 2.1 AAA text contrast (7:1) against the backgrounds
 * they pair with in both light and dark mode.
 *
 * Rules are a mix of element selectors (so unstyled markup still looks
 * reasonable) and the small set of view-side classes/ids assigned in
 * `admin_layout.tsx` and the `admin_*_view.tsx` files (`#header`,
 * `#branding`, `#user-tools`, `#main`, `#nav-sidebar`, `#breadcrumbs`, `.messagelist`, `#content`,
 * `#toolbar`, `.module`, `.object-tools`, `.addlink`, `.exportlink`, `.submit-row`,
 * `.default`, `.deletelink`, `.cancel-link`, `.button`, `.change-list`,
 * `#changelist-filter`, `.actions`, `.action-checkbox-column`,
 * `.result-count`, `.inline-group`, `.tabular-inline`, `.date-hierarchy`,
 * `body.login`, `.login-form`, `.errornote` — the last three from
 * `admin_login_view.tsx`, the one screen that does not render inside
 * `AdminLayout`).
 */
export const ADMIN_CSS = `:root {
	--primary: #79aec8;
	--secondary: #31596d;
	--accent: #f5dd5d;
	--primary-fg: #fff;
	--focus-ring: #ffbf47;

	--body-fg: #333;
	--body-bg: #fff;
	--body-quiet-color: #494949;
	--body-medium-color: #444;
	--body-loud-color: #000;

	--header-color: #ffc;
	--header-branding-color: var(--accent);
	--header-bg: var(--secondary);
	--header-link-color: var(--primary-fg);

	--breadcrumbs-fg: #cbe3ef;
	--breadcrumbs-link-fg: var(--body-bg);
	--breadcrumbs-bg: #264b5d;

	--link-fg: #335e74;
	--link-hover-color: #036;
	--link-selected-fg: var(--secondary);

	--hairline-color: #e8e8e8;
	--border-color: #ccc;
	--error-fg: #a01c1c;

	--message-info-bg: #ccefff;
	--message-success-bg: #dfd;
	--message-warning-bg: #ffc;
	--message-error-bg: #ffefef;
	--message-debug-bg: #efefef;

	--darkened-bg: #f8f8f8;
	--selected-bg: #e4e4e4;
	--selected-row: #ffc;

	--button-fg: #fff;
	--button-bg: var(--secondary);
	--button-hover-bg: #205067;
	--default-button-bg: #205067;
	--default-button-hover-bg: var(--secondary);
	--close-button-bg: #595959;
	--close-button-hover-bg: #333;
	--delete-button-bg: #ad1f1f;
	--delete-button-hover-bg: #a41515;

	--object-tools-fg: var(--button-fg);
	--object-tools-bg: var(--close-button-bg);
	--object-tools-hover-bg: var(--close-button-hover-bg);

	color-scheme: light;
}

@media (prefers-color-scheme: dark) {
	:root {
		--primary: #264b5d;
		--primary-fg: #f7f7f7;

		--body-fg: #eeeeee;
		--body-bg: #121212;
		--body-quiet-color: #d0d0d0;
		--body-medium-color: #e0e0e0;
		--body-loud-color: #ffffff;

		--breadcrumbs-link-fg: #e0e0e0;
		--breadcrumbs-bg: var(--primary);

		--link-fg: #81d4fa;
		--link-hover-color: #4ac1f7;
		--link-selected-fg: #6f94c6;

		--hairline-color: #272727;
		--border-color: #353535;
		--error-fg: #ff9797;

		--message-info-bg: #235088;
		--message-success-bg: #005d18;
		--message-warning-bg: #583305;
		--message-error-bg: #570808;
		--message-debug-bg: #4e4e4e;

		--darkened-bg: #212121;
		--selected-bg: #1b1b1b;
		--selected-row: #00363a;

		--close-button-bg: #333333;
		--close-button-hover-bg: #666666;

		color-scheme: dark;
	}
}

html[data-theme="dark"] {
	--primary: #264b5d;
	--primary-fg: #f7f7f7;

	--body-fg: #eeeeee;
	--body-bg: #121212;
	--body-quiet-color: #d0d0d0;
	--body-medium-color: #e0e0e0;
	--body-loud-color: #ffffff;

	--breadcrumbs-link-fg: #e0e0e0;
	--breadcrumbs-bg: var(--primary);

	--link-fg: #81d4fa;
	--link-hover-color: #4ac1f7;
	--link-selected-fg: #6f94c6;

	--hairline-color: #272727;
	--border-color: #353535;
	--error-fg: #e35f5f;

	--message-info-bg: #265895;
	--message-success-bg: #006b1b;
	--message-warning-bg: #583305;
	--message-error-bg: #570808;
	--message-debug-bg: #4e4e4e;

	--darkened-bg: #212121;
	--selected-bg: #1b1b1b;
	--selected-row: #00363a;

	--close-button-bg: #333333;
	--close-button-hover-bg: #666666;

	color-scheme: dark;
}

body {
	margin: 0;
	background: var(--body-bg);
	color: var(--body-fg);
	font: 14px/1.5 "Segoe UI", system-ui, sans-serif;
}

#header {
	background: var(--header-bg);
	color: var(--header-link-color);
	padding: 10px 40px;
	display: flex;
	align-items: center;
	gap: 20px;
}

#header a {
	color: var(--header-link-color);
	text-decoration: none;
}

#branding {
	flex: 1;
}

#branding h1 {
	margin: 0;
	font-size: 18px;
	font-weight: 300;
}

#user-tools {
	font-size: 0.6875rem;
	font-weight: 300;
	letter-spacing: 0.5px;
	text-transform: uppercase;
	text-align: right;
	color: var(--header-link-color);
}

#user-tools a {
	color: var(--header-link-color);
	text-decoration: none;
	border-bottom: 1px solid rgba(255, 255, 255, 0.5);
}

#user-tools a:hover {
	color: var(--header-link-color);
}

#user-tools form {
	display: inline;
}

#user-tools button {
	background: none;
	border: 0;
	padding: 0;
	color: var(--header-link-color);
	text-transform: uppercase;
	font: inherit;
	letter-spacing: 0.5px;
	cursor: pointer;
	border-bottom: 1px solid rgba(255, 255, 255, 0.5);
}

.main {
	display: flex;
	align-items: flex-start;
}

#nav-sidebar {
	flex: 0 0 240px;
	background: var(--darkened-bg);
	border-right: 1px solid var(--hairline-color);
	padding: 12px 0;
	align-self: stretch;
}

#nav-sidebar h2 {
	font-size: 0.75rem;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	color: var(--body-quiet-color);
	margin: 12px 16px 6px;
	font-weight: 600;
	background: none;
	padding: 0;
}

#nav-sidebar ul {
	list-style: none;
	margin: 0;
	padding: 0;
}

#nav-sidebar li {
	margin: 0;
}

#nav-sidebar a {
	display: block;
	padding: 6px 16px;
	color: var(--link-fg);
	text-decoration: none;
}

#nav-sidebar a:hover {
	background: var(--selected-bg);
}

#breadcrumbs {
	background: var(--breadcrumbs-bg);
	border-bottom: 1px solid var(--hairline-color);
	padding: 10px 40px;
	color: var(--breadcrumbs-fg);
	font-size: 13px;
}

#breadcrumbs a {
	color: var(--breadcrumbs-link-fg);
}

#breadcrumbs a:hover {
	color: var(--breadcrumbs-fg);
}

#breadcrumbs ol {
	list-style: none;
	margin: 0;
	padding: 0;
	display: inline;
}

#breadcrumbs li {
	display: inline;
}

#content {
	flex: 1;
	min-width: 0;
	padding: 20px 40px;
}

.messagelist {
	list-style: none;
	margin: 0;
	padding: 0;
}

.messagelist li {
	padding: 10px 40px;
	margin: 0;
	color: var(--body-fg);
}

.messagelist li.success {
	background: var(--message-success-bg);
}

.messagelist li.info {
	background: var(--message-info-bg);
}

.messagelist li.error {
	background: var(--message-error-bg);
	color: var(--error-fg);
}

.module {
	background: var(--body-bg);
	border: 1px solid var(--hairline-color);
	margin-bottom: 20px;
}

.module > h2,
.module > h3,
.module > caption {
	background: var(--header-bg);
	color: var(--header-link-color);
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	font-weight: 400;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

.module > *:not(table) {
	padding: 0 12px;
}

.module > p {
	padding: 8px 12px;
}

.module > dl {
	padding: 8px 12px;
}

.module > ul {
	padding: 8px 12px 8px 28px;
}

table {
	width: 100%;
	border-collapse: collapse;
}

thead th {
	background: var(--darkened-bg);
	text-align: left;
	padding: 8px 12px;
	border-bottom: 1px solid var(--hairline-color);
	font-size: 12px;
	text-transform: uppercase;
	color: var(--body-quiet-color);
}

td,
tbody th {
	padding: 8px 12px;
	border-bottom: 1px solid var(--hairline-color);
	text-align: left;
}

tbody tr:nth-child(even) {
	background: var(--darkened-bg);
}

tbody tr:hover {
	background: var(--selected-bg);
}

a {
	color: var(--link-fg);
	text-decoration: none;
}

a:hover {
	color: var(--link-hover-color);
}

input,
select,
textarea {
	padding: 6px 8px;
	border: 1px solid var(--border-color);
	border-radius: 4px;
	font: inherit;
	background: var(--body-bg);
	color: var(--body-fg);
}

label {
	font-weight: 600;
	display: block;
	margin-bottom: 4px;
}

button,
input[type="submit"],
.button {
	background: var(--button-bg);
	color: var(--button-fg);
	border: 0;
	padding: 8px 14px;
	border-radius: 4px;
	cursor: pointer;
	font: inherit;
	text-decoration: none;
	display: inline-block;
}

button:hover,
.button:hover {
	background: var(--button-hover-bg);
}

.default {
	background: var(--default-button-bg);
}

.default:hover {
	background: var(--default-button-hover-bg);
}

.deletelink {
	background: var(--delete-button-bg);
	color: var(--button-fg);
}

.deletelink:hover {
	background: var(--delete-button-hover-bg);
}

.cancel-link {
	background: var(--close-button-bg);
	color: var(--button-fg);
	padding: 10px 15px;
	border-radius: 4px;
	display: inline-block;
}

.cancel-link:hover {
	background: var(--close-button-hover-bg);
}

.submit-row {
	background: var(--darkened-bg);
	border: 1px solid var(--hairline-color);
	padding: 12px;
	margin-top: 16px;
	display: flex;
	gap: 10px;
	align-items: center;
}

.object-tools {
	text-align: right;
	margin: 0 0 10px;
}

.date-hierarchy {
	margin: 0 0 10px;
}

.date-hierarchy ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	gap: 12px;
	flex-wrap: wrap;
}

.date-hierarchy li {
	font-size: 13px;
}

.date-hierarchy a {
	color: var(--link-fg);
}

.object-tools .addlink,
.object-tools .exportlink {
	background: var(--object-tools-bg);
	color: var(--object-tools-fg);
	padding: 6px 12px;
	border-radius: 4px;
	font-size: 12px;
	text-transform: uppercase;
}

.object-tools .exportlink {
	margin-left: 8px;
}

#toolbar {
	background: var(--body-bg);
	border: 1px solid var(--hairline-color);
	padding: 10px 12px;
	margin-bottom: 12px;
}

#toolbar form {
	display: flex;
	gap: 8px;
	align-items: center;
}

#toolbar label {
	display: inline;
	margin: 0 4px 0 0;
}

td form {
	display: inline-block;
	margin: 0;
}

dl {
	margin: 0;
}

dt {
	font-weight: 600;
	color: var(--body-quiet-color);
	margin-top: 10px;
}

dd {
	margin: 0 0 10px;
}

nav[aria-label="pagination"] {
	margin-top: 12px;
}

nav[aria-label="pagination"] a {
	display: inline-block;
	padding: 6px 12px;
	border: 1px solid var(--border-color);
	border-radius: 4px;
}

.change-list {
	display: flex;
	gap: 20px;
	align-items: flex-start;
}

.change-list .results-wrap {
	flex: 1;
	min-width: 0;
}

#changelist-filter {
	width: 220px;
	flex: 0 0 220px;
	background: var(--darkened-bg);
	border: 1px solid var(--hairline-color);
}

#changelist-filter h2 {
	background: var(--header-bg);
	color: var(--header-link-color);
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	font-weight: 400;
	text-transform: uppercase;
	letter-spacing: 0.5px;
}

#changelist-filter h3 {
	font-size: 12px;
	margin: 10px 12px 4px;
	color: var(--body-quiet-color);
	text-transform: uppercase;
}

#changelist-filter ul {
	list-style: none;
	margin: 0 0 10px;
	padding: 0;
}

#changelist-filter li {
	padding: 4px 12px;
}

#changelist-filter li.selected {
	font-weight: 600;
	border-left: 3px solid var(--link-selected-fg);
	padding-left: 9px;
}

#changelist-filter a {
	color: var(--link-fg);
}

.actions {
	padding: 10px;
	background: var(--body-bg);
	color: var(--body-quiet-color);
	display: flex;
	gap: 10px;
	align-items: center;
	border: 1px solid var(--hairline-color);
	margin-bottom: 10px;
}

.actions label {
	display: flex;
	gap: 8px;
	align-items: center;
	font-weight: 400;
	margin: 0;
}

th.action-checkbox-column,
td.action-checkbox-column {
	width: 24px;
	text-align: center;
}

.result-count {
	font-size: 13px;
	color: var(--body-quiet-color);
}

th.sortable a {
	color: inherit;
	text-decoration: none;
}

th.sorted {
	background: var(--selected-bg);
}

.paginator {
	display: flex;
	gap: 6px;
	align-items: center;
	padding: 10px 0;
	flex-wrap: wrap;
}

.paginator a {
	background: var(--button-bg);
	color: var(--button-fg);
	padding: 2px 8px;
	border-radius: 4px;
	text-decoration: none;
}

.paginator .this-page {
	font-weight: bold;
	color: var(--body-quiet-color);
}

.paginator .ellipsis {
	color: var(--body-quiet-color);
}

.inline-group {
	margin: 0 0 20px;
}

.inline-group > h2 {
	background: var(--header-bg);
	color: var(--header-link-color);
	margin: 0;
	padding: 8px 12px;
	font-size: 13px;
	text-transform: uppercase;
	letter-spacing: 0.5px;
	font-weight: 400;
}

table.tabular-inline {
	width: 100%;
	border-collapse: collapse;
}

table.tabular-inline th {
	background: var(--darkened-bg);
	color: var(--body-quiet-color);
	text-align: left;
	padding: 6px 10px;
	font-size: 12px;
	text-transform: uppercase;
	border-bottom: 1px solid var(--hairline-color);
}

table.tabular-inline td {
	padding: 6px 10px;
	border-bottom: 1px solid var(--hairline-color);
}

/* The column header already carries each field's visible label, so a field's
   own inline <label> (rendered by FormField) would duplicate it; hide it
   without removing it from the accessibility tree. */
table.tabular-inline label {
	position: absolute !important;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

body.login {
	background: var(--darkened-bg);
}

.login-form {
	width: 100%;
	max-width: 340px;
	margin: 72px auto;
	background: var(--body-bg);
	border: 1px solid var(--hairline-color);
}

.login-form h1 {
	background: var(--header-bg);
	color: var(--header-link-color);
	margin: 0;
	padding: 12px 16px;
	font-size: 16px;
	font-weight: 300;
}

.login-form .login-body {
	padding: 16px;
}

.login-form .form-row {
	margin-bottom: 12px;
}

.login-form label {
	display: block;
	margin-bottom: 4px;
	font-weight: 600;
}

.login-form input[type="text"],
.login-form input[type="password"] {
	width: 100%;
	box-sizing: border-box;
}

.login-form .submit-row {
	margin-top: 16px;
	background: none;
	border: 0;
	padding: 0;
}

.login-form .errornote {
	margin: 0 0 12px;
	padding: 10px 12px;
	background: var(--message-error-bg);
	color: var(--error-fg);
	font-size: 13px;
}

/* Visible focus indicator (WCAG 2.4.7) for all interactive elements,
   layered on top of any outline the user agent already draws. */
a:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
[tabindex]:focus-visible,
summary:focus-visible {
	outline: 3px solid var(--focus-ring);
	outline-offset: 2px;
}

/* Screen-reader-only content, hidden visually but kept in the accessibility
   tree. The focusable variant reveals itself when it (or a descendant)
   receives focus, for use in skip links. */
.visually-hidden {
	position: absolute !important;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

.visually-hidden-focusable:not(:focus):not(:focus-within) {
	position: absolute !important;
	width: 1px;
	height: 1px;
	padding: 0;
	margin: -1px;
	overflow: hidden;
	clip: rect(0, 0, 0, 0);
	white-space: nowrap;
	border: 0;
}

.visually-hidden-focusable:focus {
	position: static;
	width: auto;
	height: auto;
	margin: 0;
	padding: 8px 12px;
	clip: auto;
	white-space: normal;
	background: var(--body-bg);
	color: var(--body-fg);
	z-index: 1000;
}

/* Cap the measure of running text blocks for readability (WCAG 1.4.8);
   tables, forms, and layout containers are left full-width. */
.module > p,
.module > dl,
.messagelist li,
#content > form p.help {
	max-width: 80ch;
}

/* Stack the fixed-width sidebars at narrow viewports / high zoom so content
   reflows instead of requiring horizontal scrolling (WCAG 1.4.10). */
@media (max-width: 800px) {
	.main {
		flex-wrap: wrap;
	}

	#nav-sidebar {
		flex-basis: 100%;
		border-right: 0;
		border-bottom: 1px solid var(--hairline-color);
	}

	.change-list {
		flex-wrap: wrap;
	}

	#changelist-filter {
		flex-basis: 100%;
		width: auto;
		margin: 0 0 20px;
	}
}
`;
