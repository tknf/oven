/**
 * Minimal styles for the admin screen. Since CF Workers has no runtime fs support
 * and `vp pack` does not support `?raw`, the CSS ends up as a string in the JS
 * bundle either way. Given that, holding it as a string constant from the start is
 * more minimal than an external .css file plus a transform. `AdminLayout` inlines
 * this into `<style>`.
 */
export const ADMIN_CSS = `body {
	margin: 0;
	font-family: system-ui, sans-serif;
	color: #1a1a1a;
}

header {
	display: flex;
	align-items: center;
	gap: 1.5rem;
	padding: 0.75rem 1.5rem;
	border-bottom: 1px solid #ddd;
}

header h1 {
	font-size: 1.125rem;
	margin: 0;
}

header nav ul {
	display: flex;
	gap: 1rem;
	margin: 0;
	padding: 0;
	list-style: none;
}

main {
	padding: 1.5rem;
}

table {
	border-collapse: collapse;
	width: 100%;
	margin-bottom: 1.5rem;
}

th,
td {
	border: 1px solid #ddd;
	padding: 0.5rem 0.75rem;
	text-align: left;
}

form {
	display: inline;
	margin: 0;
}

button {
	cursor: pointer;
}
`;
