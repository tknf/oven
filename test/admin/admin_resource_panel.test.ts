/**
 * Tests for `AdminPanel`'s resource CRUD section wiring (Step 3b; `AdminResource` in
 * `admin_resource.ts`). Modeled on the "real class injection (integration)" tests in
 * `admin_panel.test.ts`: injects real `SQLiteModel` and `Form` subclasses, which
 * simultaneously proves `SQLiteModel -> AdminModel` assignability (compiling without
 * `as` is itself the proof) and exercises the `fieldsFromTable` end-to-end path.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { AdminPanel } from "../../src/admin/admin_panel.js";
import { AdminResource, fieldsFromTable } from "../../src/admin/admin_resource.js";
import { SQLiteAuditLog } from "../../src/audit/sqlite_audit_log.js";
import type { FieldDef } from "../../src/form/form.js";
import { Form } from "../../src/form/form.js";
import { SQLiteModel } from "../../src/model/sqlite_model.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

/** Minimal Standard Schema implementation for tests. Same convention as `defineStubSchema` in `test/form/form.test.ts`. */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate,
	},
});

type PublisherInput = { name: string; contactEmail: string; status: string };

/** Real `SQLiteModel` subclass that operates on the `publishers` table. */
class PublisherModel extends SQLiteModel<
	typeof schema.publishers,
	typeof schema.publishers.id,
	typeof schema
> {
	protected get table() {
		return schema.publishers;
	}
	protected get primaryKey() {
		return schema.publishers.id;
	}
}

/** Admin form for `publishers` that fails validation when `name`/`contactEmail` is empty. */
class PublisherForm extends Form<StandardSchemaV1<unknown, PublisherInput>, string> {
	protected schema() {
		return defineStubSchema<PublisherInput>((value) => {
			const record = value as Record<string, unknown>;
			const issues: StandardSchemaV1.Issue[] = [];
			if (typeof record.name !== "string" || record.name === "") {
				issues.push({ message: "Name is required", path: ["name"] });
			}
			if (typeof record.contactEmail !== "string" || record.contactEmail === "") {
				issues.push({ message: "Contact email is required", path: ["contactEmail"] });
			}
			if (issues.length > 0) return { issues };
			return {
				value: {
					name: record.name as string,
					contactEmail: record.contactEmail as string,
					status: (record.status as string | undefined) ?? "active",
				},
			};
		});
	}
	protected fields(): Record<string, FieldDef> {
		return fieldsFromTable(schema.publishers);
	}
}

/** Writable `publishers` resource. */
class PublisherResource extends AdminResource {
	constructor(private readonly publisherModel: PublisherModel) {
		super();
	}
	get key() {
		return "publishers";
	}
	get label() {
		return "Publisher";
	}
	get model() {
		return this.publisherModel;
	}
	get table() {
		return schema.publishers;
	}
	get primaryKey() {
		return "id";
	}
	form() {
		return new PublisherForm();
	}
	searchColumns() {
		return ["name"];
	}
}

/** Read-only (no `form()` implementation) `publishers` resource, for verifying that write routes are not registered. */
class ReadonlyPublisherResource extends AdminResource {
	constructor(private readonly publisherModel: PublisherModel) {
		super();
	}
	get key() {
		return "ro-publishers";
	}
	get label() {
		return "Publisher (read-only)";
	}
	get model() {
		return this.publisherModel;
	}
	get table() {
		return schema.publishers;
	}
	get primaryKey() {
		return "id";
	}
	searchColumns() {
		return ["name"];
	}
}

/** Inserts one row into the `publishers` table. */
const insertPublisher = async (
	db: Awaited<ReturnType<typeof createTestDb<typeof schema>>>["db"],
	overrides: Partial<typeof schema.publishers.$inferInsert> &
		Pick<typeof schema.publishers.$inferInsert, "id" | "name">,
) => {
	const now = Date.now();
	await db.insert(schema.publishers).values({
		contactEmail: overrides.contactEmail ?? `${overrides.id}@example.com`,
		status: overrides.status ?? "active",
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		...overrides,
	});
};

describe("AdminPanel resource CRUD", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	test("list: includes the name of seeded rows", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });

		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("TKNF Books");
		expect(body).toContain("Another Press");
	});

	test("search: q includes only partially matching rows", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });

		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers?q=TKNF");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("TKNF Books");
		expect(body).not.toContain("Another Press");
	});

	test("search: %/_ in q are matched literally rather than expanded as LIKE wildcards", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });

		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		/**
		 * `_` is LIKE's "any single character" wildcard. If issued unescaped as `%_%`, the
		 * condition becomes "contains at least one character", which would match every row
		 * (none of which actually contain `_`). If escaping is working, the result is 0 rows
		 * since no row actually contains `_`.
		 */
		const res = await app.request("/admin/resources/publishers?q=_");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).not.toContain("TKNF Books");
		expect(body).not.toContain("Another Press");
	});

	test("new form: GET includes the name input etc.", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/new");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain('name="name"');
	});

	test("create: POST adds one row to the DB, redirects to the list with 303, and records resource.create in the audit log", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits);
		const app = new Hono();
		app.route(
			"/admin",
			new AdminPanel({ authorize: () => true, resources: [resource], audit: { log: auditLog } }),
		);

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
			}).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");

		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("New Publisher");

		const auditRows = await auditLog.list({ action: "resource.create" });
		expect(auditRows).toHaveLength(1);
	});

	test("create: re-renders the form with 422 on validation failure", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ name: "", contactEmail: "" }).toString(),
		});

		expect(res.status).toBe(422);
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(0);
	});

	test("show: GET includes the row content", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("TKNF Books");
	});

	test("edit form: GET prefills the existing values", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1/edit");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain('value="TKNF Books"');
	});

	test("update: POST changes the target row in the DB and returns 303", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "Renamed Publisher",
				contactEmail: "renamed@example.com",
				status: "active",
			}).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");

		const [row] = await ctx.db
			.select()
			.from(schema.publishers)
			.where(eq(schema.publishers.id, "pub-1"));
		expect(row?.name).toBe("Renamed Publisher");
	});

	test("delete: POST removes the row from the DB and returns 303", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1/delete", { method: "POST" });

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(0);
	});

	test("read-only: list/show return 200 but new/create/edit/delete return 404 (route not registered)", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new ReadonlyPublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const listRes = await app.request("/admin/resources/ro-publishers");
		const showRes = await app.request("/admin/resources/ro-publishers/pub-1");
		const newRes = await app.request("/admin/resources/ro-publishers/new");
		const createRes = await app.request("/admin/resources/ro-publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ name: "x" }).toString(),
		});
		const editRes = await app.request("/admin/resources/ro-publishers/pub-1/edit");
		const deleteRes = await app.request("/admin/resources/ro-publishers/pub-1/delete", {
			method: "POST",
		});

		expect(listRes.status).toBe(200);
		expect(showRes.status).toBe(200);
		expect(newRes.status).toBe(404);
		expect(createRes.status).toBe(404);
		expect(editRes.status).toBe(404);
		expect(deleteRes.status).toBe(404);
	});

	test("update: mixing the primary key (id) into the body does not overwrite the target row's primary key", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const publisherModel = new PublisherModel(ctx.db);
		const resource = new PublisherResource(publisherModel);
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				id: "pub-hijacked",
				name: "Renamed Publisher",
				contactEmail: "renamed@example.com",
				status: "active",
			}).toString(),
		});

		expect(res.status).toBe(303);

		const original = await publisherModel.retrieve("pub-1");
		expect(original?.name).toBe("Renamed Publisher");
		const hijacked = await publisherModel.retrieve("pub-hijacked");
		expect(hijacked).toBeUndefined();
	});

	test("navigation: the dashboard HTML shows a link to the resource", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("/admin/resources/publishers");
		expect(body).toContain("Publisher");
	});
});

describe("AdminPanel resource CRUD authorization", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	test("all routes under the resource return 403 when authorize returns false (default denyStatus)", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => false, resources: [resource] }));

		const list = await app.request("/admin/resources/publishers");
		const show = await app.request("/admin/resources/publishers/pub-1");
		const newForm = await app.request("/admin/resources/publishers/new");
		const create = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ name: "x", contactEmail: "x@example.com" }).toString(),
		});
		const editForm = await app.request("/admin/resources/publishers/pub-1/edit");
		const update = await app.request("/admin/resources/publishers/pub-1", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ name: "x", contactEmail: "x@example.com" }).toString(),
		});
		const remove = await app.request("/admin/resources/publishers/pub-1/delete", {
			method: "POST",
		});

		expect(list.status).toBe(403);
		expect(show.status).toBe(403);
		expect(newForm.status).toBe(403);
		expect(create.status).toBe(403);
		expect(editForm.status).toBe(403);
		expect(update.status).toBe(403);
		expect(remove.status).toBe(403);
	});
});
