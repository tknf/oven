/**
 * Permission-string vocabulary for admin-panel operator accounts.
 *
 * A permission is a plain string. Resource permissions follow the shape
 * `resource.<resourceKey>.<action>` (built by `resourcePermission`), and a small
 * set of built-in permissions covers the non-resource admin screens
 * (`AdminBuiltinPermission`). Permission strings are compared by literal set
 * membership only and are never parsed or split at check time, so a resource key
 * containing dots cannot break matching (the string granted is the string
 * checked, verbatim). Superusers bypass permission checks entirely; that bypass
 * is enforced by the consumer of this vocabulary, not here.
 */

/** The four actions a resource permission can grant, in a fixed order. */
export const ADMIN_PERMISSION_ACTIONS = ["view", "create", "update", "delete"] as const;

/** One of the four resource-permission actions (derived from `ADMIN_PERMISSION_ACTIONS` so the two stay in sync). */
export type AdminPermissionAction = (typeof ADMIN_PERMISSION_ACTIONS)[number];

/**
 * Every built-in permission for the non-resource admin screens (jobs,
 * settings, audit log), in no particular order. Also the enumeration an
 * accounts management UI offers when granting a known permission to a user or
 * group (as opposed to a resource permission, which is derived per-resource
 * via `resourcePermission`/`resourcePermissions`).
 */
export const ADMIN_BUILTIN_PERMISSIONS = [
	"jobs.view",
	"jobs.manage",
	"settings.view",
	"settings.manage",
	"audit.view",
] as const;

/** One of the built-in permissions for the non-resource admin screens (derived from `ADMIN_BUILTIN_PERMISSIONS` so the two stay in sync). */
export type AdminBuiltinPermission = (typeof ADMIN_BUILTIN_PERMISSIONS)[number];

/** Any permission string this vocabulary produces: a resource permission or a built-in one. */
export type AdminPermission =
	| `resource.${string}.${AdminPermissionAction}`
	| AdminBuiltinPermission;

/** Builds the permission string granting `action` on the resource identified by `resourceKey`. */
export const resourcePermission = (
	resourceKey: string,
	action: AdminPermissionAction,
): AdminPermission => `resource.${resourceKey}.${action}`;

/** Builds all four action permissions for one resource key (in `ADMIN_PERMISSION_ACTIONS` order). */
export const resourcePermissions = (resourceKey: string): AdminPermission[] =>
	ADMIN_PERMISSION_ACTIONS.map((action) => resourcePermission(resourceKey, action));

/**
 * Parses the JSON stored in a user row's `permissions` TEXT column into a string
 * array. Malformed storage never throws: invalid JSON or a non-array value
 * yields `[]` (the whole value is rejected), and non-string members of an
 * otherwise valid array are dropped while the string members are kept.
 */
export const parseStoredPermissions = (raw: string): string[] => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((member): member is string => typeof member === "string");
};
