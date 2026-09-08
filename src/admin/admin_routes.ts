/** Internal route templates shared by registration and admin URL generation. */
import { NamedRoutes } from "../routing/named_routes.js";
import type { PathForArgs } from "../routing/named_routes.js";

export const ADMIN_ROUTE_PATHS = {
	dashboard: "/",
	login: "/login",
	totp: "/login/totp",
	logout: "/logout",
	jobs: "/jobs",
	jobRetry: "/jobs/:id/retry",
	jobDelete: "/jobs/:id/delete",
	settings: "/settings",
	flag: "/settings/flags/:name",
	maintenance: "/settings/maintenance",
	audit: "/audit",
	users: "/accounts/users",
	userNew: "/accounts/users/new",
	user: "/accounts/users/:id",
	userEdit: "/accounts/users/:id/edit",
	userPassword: "/accounts/users/:id/password",
	userDelete: "/accounts/users/:id/delete",
	groups: "/accounts/groups",
	groupNew: "/accounts/groups/new",
	group: "/accounts/groups/:id",
	groupEdit: "/accounts/groups/:id/edit",
	groupDelete: "/accounts/groups/:id/delete",
	resources: "/resources",
} as const;

export const ADMIN_RESOURCE_PATHS = {
	index: "/",
	new: "/new",
	show: "/:id",
	edit: "/:id/edit",
	delete: "/:id/delete",
	export: "/export.csv",
} as const;

const adminRoutes = new NamedRoutes(ADMIN_ROUTE_PATHS);
const resourceRoutes = new NamedRoutes(ADMIN_RESOURCE_PATHS);

export const adminPathFor = <TName extends keyof typeof ADMIN_ROUTE_PATHS>(
	basePath: string,
	name: TName,
	...args: PathForArgs<(typeof ADMIN_ROUTE_PATHS)[TName]>
): string => {
	const path = adminRoutes.pathFor(name, ...args);
	return `${basePath}${path.replace(/^\/(?=\?|$)/, "")}`;
};

/** Resource keys are literal mount prefixes; only record IDs are route parameters. */
export const adminResourcePathFor = <TName extends keyof typeof ADMIN_RESOURCE_PATHS>(
	basePath: string,
	resourceKey: string,
	name: TName,
	...args: PathForArgs<(typeof ADMIN_RESOURCE_PATHS)[TName]>
): string => {
	const path = resourceRoutes.pathFor(name, ...args);
	return `${adminPathFor(basePath, "resources")}/${resourceKey}${path.replace(/^\/(?=\?|$)/, "")}`;
};
