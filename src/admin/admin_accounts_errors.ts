/**
 * Error shared by the three dialect-specific admin-accounts services
 * (`SQLiteAdminAccounts`, `PgAdminAccounts`, `MySqlAdminAccounts`). Thrown by
 * `updateUser`/`deleteUser` when called with `{ protectLastActiveSuperuser: true }`
 * and the requested change would deactivate, demote, or delete the only
 * remaining active superuser. Kept in one file (rather than duplicated per
 * dialect, unlike the rest of those services) so callers can catch a single
 * class regardless of which dialect backs the accounts service in use.
 */
export class LastActiveSuperuserError extends Error {
	constructor(message = "refusing to deactivate, demote, or delete the last active superuser") {
		super(message);
		this.name = "LastActiveSuperuserError";
	}
}
