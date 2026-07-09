/**
 * Verifies `createTestDb` from `src/test/db.ts` using the minimal fixture schema dedicated to
 * this repository (`test/test_support/fixtures/schema.ts`) and its migrations.
 * Test code is exempt from the one-way import boundary applied to `src/`.
 */
import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "./fixtures/schema.js";

const migrationsFolder = new URL("./fixtures/migrations", import.meta.url).pathname;

describe("createTestDb", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("applies migrations and can INSERT/SELECT on a known table", async () => {
		const { client, db } = await createTestDb({ schema, migrationsFolder });
		cleanup = () => client.close();

		const publisher = {
			id: "publisher-1",
			name: "Test Publisher",
			contactEmail: "publisher@example.com",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		await db.insert(schema.publishers).values(publisher);

		const [found] = await db
			.select()
			.from(schema.publishers)
			.where(eq(schema.publishers.id, publisher.id));

		expect(found?.name).toBe("Test Publisher");
	});

	test("PRAGMA foreign_keys is enabled", async () => {
		const { client } = await createTestDb({ schema, migrationsFolder });
		cleanup = () => client.close();

		const result = await client.execute("PRAGMA foreign_keys");

		expect(result.rows[0]?.[0]).toBe(1);
	});

	test("client.close() removes the temporary directory", async () => {
		const { client } = await createTestDb({ schema, migrationsFolder });
		const databaseList = await client.execute("PRAGMA database_list");
		const dbFile = databaseList.rows[0]?.[2];
		if (typeof dbFile !== "string") {
			throw new Error("failed to get the DB file path from PRAGMA database_list");
		}
		const dir = dirname(dbFile);

		expect(existsSync(dir)).toBe(true);

		client.close();

		expect(existsSync(dir)).toBe(false);
	});
});
