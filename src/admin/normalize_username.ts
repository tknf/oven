/**
 * Normalizes an admin username (trim + lowercase) for building a rate-limiter
 * key. `AdminPanel`'s `/login` route (`admin_panel.tsx`) uses this so the
 * login rate limiter's key agrees with the value the admin-accounts services
 * key their lookups by — otherwise case/whitespace variants of one username
 * (`Admin`, `ADMIN`, ` admin `) would each get an independent attempt budget
 * while all resolving to the same account, multiplying the effective
 * brute-force budget.
 *
 * The algorithm MUST stay identical to the internal `normalizeUsername`
 * duplicated in `sqlite_admin_accounts.ts`, `pg_admin_accounts.ts`, and
 * `mysql_admin_accounts.ts` (see each module's "Username normalization"
 * JSDoc). Those three intentionally do not import this helper: per the
 * dialect-specific parallel-implementation convention documented on those
 * modules, each accounts service shares no abstraction with the others, only
 * the method vocabulary and algorithm are meant to be portable. Extracted
 * here as its own module (rather than inlined in `admin_panel.tsx`) purely so
 * the rate-limiter key construction does not silently drift from the
 * services' normalization if this one copy changes.
 */
export const normalizeAdminUsername = (username: string): string => username.trim().toLowerCase();
