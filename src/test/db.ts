/**
 * Test-only, file-based libSQL (Turso) DB factory. Bundled as part of
 * `@tknf/oven/test`. Production code uses `@libsql/client/web`, but since
 * this is test-only it uses the Node entry point (`@libsql/client`) instead.
 *
 * Why a per-test temp file instead of `:memory:`: `@libsql/client`'s Node
 * native (sqlite3) driver hands the original connection over exclusively to
 * the transaction once `transaction()` starts, and lazily creates a new
 * connection for any subsequent (non-transactional) query. Because
 * `:memory:` gives each connection its own independent database, calling
 * `db.transaction()` even once causes later queries on the same `db` to hit a
 * fresh, empty database, resulting in "no such table". With a file-based
 * database, a new connection still points at the same file, so this problem
 * does not occur.
 */
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * createTestDb: creates a libSQL client and its Drizzle wrapper in a fresh
 * temporary directory for each test, returning both. It applies the given
 * `migrationsFolder` every time before returning, so mismatches between the
 * schema and the queries can also be caught. Cleanup of the temporary
 * directory piggybacks on the caller's `client.close()` call (the common
 * afterEach pattern used across existing tests).
 *
 * `schema` should be the app's full set of drizzle schema definitions (the
 * result of `import * as schema`). The returned `db` reflects the type of the
 * given `schema` (`TSchema`).
 */
export const createTestDb = async <TSchema extends Record<string, unknown>>(options: {
	schema: TSchema;
	migrationsFolder: string;
}) => {
	const { schema, migrationsFolder } = options;
	const dir = mkdtempSync(join(tmpdir(), "oven-test-db-"));
	const client = createClient({ url: `file:${join(dir, `${randomUUID()}.sqlite`)}` });
	const closeAndCleanUp = client.close.bind(client);
	client.close = () => {
		closeAndCleanUp();
		rmSync(dir, { recursive: true, force: true });
	};

	// Enable foreign key constraints right after connecting (matches production DB client behavior)
	await client.execute("PRAGMA foreign_keys = ON");

	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder });

	return { client, db };
};
