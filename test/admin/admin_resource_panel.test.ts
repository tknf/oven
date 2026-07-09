/**
 * Tests for `AdminPanel`'s resource CRUD section wiring (Step 3b; `AdminResource` in
 * `admin_resource.ts`). Modeled on the "real class injection (integration)" tests in
 * `admin_panel.test.ts`: injects real `SQLiteModel` and `Form` subclasses, which
 * simultaneously proves `SQLiteModel -> AdminModel` assignability (compiling without
 * `as` is itself the proof) and exercises the `fieldsFromTable` end-to-end path.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { eq } from "drizzle-orm";
import type { Env } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { AdminPanel } from "../../src/admin/admin_panel.js";
import { AdminResource, fieldsFromTable } from "../../src/admin/admin_resource.js";
import { SQLiteAuditLog } from "../../src/audit/sqlite_audit_log.js";
import type { FieldDef } from "../../src/form/form.js";
import { Form } from "../../src/form/form.js";
import { SQLiteModel } from "../../src/model/sqlite_model.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

type SessionEnv = Env & { Variables: { session: Session } };

/** Extracts only the cookie name=value pair from a `Set-Cookie` header value (same convention as `test/security/csrf.test.ts`). */
const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

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
	filters() {
		return [
			{
				column: "status",
				label: "Status",
				options: [
					{ value: "active", label: "Active" },
					{ value: "inactive", label: "Inactive" },
				],
			},
		];
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

	test("filter: a declared status value includes only the matching rows", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books", status: "active" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press", status: "inactive" });

		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers?status=inactive");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).not.toContain("TKNF Books");
		expect(body).toContain("Another Press");
	});

	test("filter: a value outside the declared options is ignored and every row is returned", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books", status: "active" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press", status: "inactive" });

		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers?status=bogus");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("TKNF Books");
		expect(body).toContain("Another Press");
	});

	test("filter: the sidebar renders only for a resource that declares filters", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });

		const withFilters = new PublisherResource(new PublisherModel(ctx.db));
		const withoutFilters = new ReadonlyPublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route(
			"/admin",
			new AdminPanel({ authorize: () => true, resources: [withFilters, withoutFilters] }),
		);

		const withRes = await app.request("/admin/resources/publishers");
		const withoutRes = await app.request("/admin/resources/ro-publishers");

		expect(await withRes.text()).toContain('id="changelist-filter"');
		expect(await withoutRes.text()).not.toContain('id="changelist-filter"');
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

	test("delete confirmation: GET renders the confirm text, the object summary, and the post=yes hidden field", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1/delete");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("Are you sure you want to delete this Publisher?");
		expect(body).toContain("TKNF Books");
		expect(body).toContain('name="post"');
		expect(body).toContain('value="yes"');
	});

	test("delete confirmation: GET for a nonexistent id returns 404", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/missing/delete");

		expect(res.status).toBe(404);
	});

	test("delete: POST with post=yes removes the row from the DB and returns 303", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1/delete", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ post: "yes" }).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(0);
	});

	test("delete: POST without post=yes does not delete the row", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/pub-1/delete", { method: "POST" });

		expect(res.status).toBe(303);
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
	});

	test("delete: POST with post=yes for a nonexistent id returns 404", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers/missing/delete", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ post: "yes" }).toString(),
		});

		expect(res.status).toBe(404);
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
		const deleteConfirmRes = await app.request("/admin/resources/ro-publishers/pub-1/delete");
		const deleteRes = await app.request("/admin/resources/ro-publishers/pub-1/delete", {
			method: "POST",
		});

		expect(listRes.status).toBe(200);
		expect(showRes.status).toBe(200);
		expect(newRes.status).toBe(404);
		expect(createRes.status).toBe(404);
		expect(editRes.status).toBe(404);
		expect(deleteConfirmRes.status).toBe(404);
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

	test("navigation: the left sidebar lists the resource under the resources heading", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(body).toContain('id="nav-sidebar"');
		const sidebar = body.slice(body.indexOf('id="nav-sidebar"'), body.indexOf("</nav>"));
		expect(sidebar).toContain('href="/admin/resources/publishers"');
		expect(sidebar).toContain("Publisher");
	});
});

describe("AdminPanel resource CRUD save button variants and success messages", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	/** Builds an `AdminPanel` test app wired with session (no CSRF) + the `publishers` resource. */
	const buildSessionWiredApp = (resource: PublisherResource) => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				authorize: () => true,
				resources: [resource],
				session: sessionAccessor.use,
			}),
		);
		return app;
	};

	test("create: pressing '_addanother' redirects to the resource's new-form URL", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
				_addanother: "1",
			}).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers/new");
	});

	test("create: pressing '_continue' redirects to the created row's edit URL", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
				_continue: "1",
			}).toString(),
		});

		expect(res.status).toBe(303);

		/**
		 * `PublisherForm`'s schema does not pass `id` through, so `SQLiteModel#create`
		 * generates it; the redirect target is asserted against the row actually
		 * persisted rather than a hand-picked id.
		 */
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
		expect(res.headers.get("location")).toBe(`/admin/resources/publishers/${rows[0]?.id}/edit`);
	});

	test("create: pressing plain '_save' redirects to the list, same as sending no button name (backward compatible)", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
				_save: "1",
			}).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");
	});

	test("messages: a success banner appears on the next GET after create, when session is injected", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = buildSessionWiredApp(resource);

		const createRes = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
			}).toString(),
		});
		expect(createRes.status).toBe(303);
		const cookie = createRes.headers.get("set-cookie");
		if (!cookie) throw new Error("expected Set-Cookie on the create response");

		const listRes = await app.request(createRes.headers.get("location") ?? "", {
			headers: { cookie: toCookieHeader(cookie) },
		});
		const body = await listRes.text();

		expect(listRes.status).toBe(200);
		expect(body).toContain('class="messagelist"');
		expect(body).toContain("successfully");

		/**
		 * Flash messages are consume-once (`Session#get`): a second GET with the same
		 * session cookie must not show the banner again.
		 */
		const secondRes = await app.request(createRes.headers.get("location") ?? "", {
			headers: { cookie: toCookieHeader(cookie) },
		});
		const secondBody = await secondRes.text();
		expect(secondBody).not.toContain('class="messagelist"');
	});

	test("messages: a success banner appears on the next GET after delete, when session is injected", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = buildSessionWiredApp(resource);

		const deleteRes = await app.request("/admin/resources/publishers/pub-1/delete", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ post: "yes" }).toString(),
		});
		expect(deleteRes.status).toBe(303);
		const cookie = deleteRes.headers.get("set-cookie");
		if (!cookie) throw new Error("expected Set-Cookie on the delete response");

		const listRes = await app.request(deleteRes.headers.get("location") ?? "", {
			headers: { cookie: toCookieHeader(cookie) },
		});
		const body = await listRes.text();

		expect(listRes.status).toBe(200);
		expect(body).toContain('class="messagelist"');
		expect(body).toContain("deleted successfully");
	});

	test("messages: no banner appears when session is not injected (backward compatible)", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const createRes = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				name: "New Publisher",
				contactEmail: "new@example.com",
				status: "active",
			}).toString(),
		});
		expect(createRes.status).toBe(303);
		expect(createRes.headers.get("set-cookie")).toBeNull();

		const listRes = await app.request("/admin/resources/publishers");
		const body = await listRes.text();

		/**
		 * `ADMIN_CSS`'s `.messagelist` rule is always inlined regardless of whether any
		 * message is shown, so the negative assertion targets the rendered `<ul>` markup
		 * specifically rather than the bare class name.
		 */
		expect(body).not.toContain('<ul class="messagelist">');
	});
});

describe("AdminPanel resource CRUD bulk delete", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	test("list: shows the total row count and a checkbox column for a writable resource", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("2 Publisher");
		expect(body).toContain('id="changelist-form"');
		expect(body).toContain('class="action-select"');
		expect(body).toContain('name="action"');
	});

	test("list: a read-only resource shows the total row count but no checkbox column or actions bar", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new ReadonlyPublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/ro-publishers");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("1 Publisher (read-only)");
		expect(body).not.toContain('id="changelist-form"');
		expect(body).not.toContain('class="action-select"');
	});

	test("bulk action: POST with action=delete and multiple _selected_action renders the confirmation page", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["action", "delete"],
				["_selected_action", "pub-1"],
				["_selected_action", "pub-2"],
			]).toString(),
		});
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("Are you sure you want to delete the selected Publisher?");
		expect(body).toContain('name="post"');
		expect(body).toContain('value="yes"');
		expect(body).toContain('name="action"');
		expect(body).toContain('value="delete"');
		expect(body).toContain('value="pub-1"');
		expect(body).toContain('value="pub-2"');

		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(2);
	});

	test("bulk action: confirmed POST (post=yes) deletes every selected row and redirects to the list with 303", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });
		await insertPublisher(ctx.db, { id: "pub-3", name: "Untouched Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["action", "delete"],
				["post", "yes"],
				["_selected_action", "pub-1"],
				["_selected_action", "pub-2"],
			]).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");

		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("pub-3");
	});

	test("bulk action: confirmed POST records one resource.bulkDelete audit entry", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits);
		const app = new Hono();
		app.route(
			"/admin",
			new AdminPanel({ authorize: () => true, resources: [resource], audit: { log: auditLog } }),
		);

		await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["action", "delete"],
				["post", "yes"],
				["_selected_action", "pub-1"],
				["_selected_action", "pub-2"],
			]).toString(),
		});

		const auditRows = await auditLog.list({ action: "resource.bulkDelete" });
		expect(auditRows).toHaveLength(1);
	});

	test("bulk action: no action selected redirects to the list without deleting anything", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["action", ""],
				["_selected_action", "pub-1"],
			]).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
	});

	test("bulk action: action=delete with no rows selected redirects to the list without deleting anything", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([["action", "delete"]]).toString(),
		});

		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/admin/resources/publishers");
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
	});

	test("create: a normal create-form POST (no action field) still creates a row, unaffected by the bulk-action dispatch", async () => {
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

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
		const rows = await ctx.db.select().from(schema.publishers);
		expect(rows).toHaveLength(1);
	});
});

describe("AdminPanel resource CRUD bulk delete success message", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	test("messages: a success banner with the deleted count appears on the next GET, when session is injected", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Another Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				authorize: () => true,
				resources: [resource],
				session: sessionAccessor.use,
			}),
		);

		const deleteRes = await app.request("/admin/resources/publishers", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams([
				["action", "delete"],
				["post", "yes"],
				["_selected_action", "pub-1"],
				["_selected_action", "pub-2"],
			]).toString(),
		});
		expect(deleteRes.status).toBe(303);
		const cookie = deleteRes.headers.get("set-cookie");
		if (!cookie) throw new Error("expected Set-Cookie on the bulk-delete response");

		const listRes = await app.request(deleteRes.headers.get("location") ?? "", {
			headers: { cookie: toCookieHeader(cookie) },
		});
		const body = await listRes.text();

		expect(listRes.status).toBe(200);
		expect(body).toContain('class="messagelist"');
		expect(body).toContain("2 Publisher were deleted successfully.");
	});
});

describe("AdminPanel resource CRUD list: sorting and numbered pagination", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	/**
	 * `PublisherResource` doesn't override `listColumns()`, so display columns
	 * follow `getTableColumns(schema.publishers)`'s declaration order:
	 * `id`(0), `name`(1), `contactEmail`(2), `status`(3), `createdAt`(4),
	 * `updatedAt`(5). Sort tests below target index `1` (`name`).
	 */
	const NAME_COLUMN_INDEX = 1;

	test("sort: ?o=<i> orders the given column ascending", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "Beta Press" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Alpha Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request(`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}`);
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body.indexOf("Alpha Books")).toBeLessThan(body.indexOf("Beta Press"));
	});

	test("sort: ?o=-<i> orders the given column descending", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "Beta Press" });
		await insertPublisher(ctx.db, { id: "pub-2", name: "Alpha Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request(`/admin/resources/publishers?o=-${NAME_COLUMN_INDEX}`);
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body.indexOf("Beta Press")).toBeLessThan(body.indexOf("Alpha Books"));
	});

	test("sort: column headers render sortable, and the active column is marked sorted", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "Beta Press" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request(`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}`);
		const body = await res.text();

		expect(body).toContain('class="sortable column-name sorted ascending"');
		expect(body).toContain('class="sortable column-status"');
	});

	test("pagination: ?p=1 shows the second page's rows, not the first page's", async () => {
		for (let i = 1; i <= 25; i++) {
			const n = String(i).padStart(2, "0");
			await insertPublisher(ctx.db, { id: `pub-${n}`, name: `Publisher ${n}` });
		}
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		// Sort by name ascending so page membership is deterministic (page size is 20).
		const firstPage = await app.request(`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}`);
		const secondPage = await app.request(`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}&p=1`);
		const firstBody = await firstPage.text();
		const secondBody = await secondPage.text();

		expect(firstBody).toContain("Publisher 01");
		expect(firstBody).not.toContain("Publisher 21");
		expect(secondBody).toContain("Publisher 21");
		expect(secondBody).not.toContain("Publisher 01");
	});

	test("pagination: the paginator renders numbered links and the total count", async () => {
		for (let i = 1; i <= 25; i++) {
			const n = String(i).padStart(2, "0");
			await insertPublisher(ctx.db, { id: `pub-${n}`, name: `Publisher ${n}` });
		}
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers");
		const body = await res.text();

		expect(body).toContain('class="paginator"');
		expect(body).toContain('aria-current="page"');
		expect(body).toContain("25 Publisher");
	});

	test("pagination: a single page of results renders no numbered links", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request("/admin/resources/publishers");
		const body = await res.text();

		expect(body).not.toContain("aria-current");
		expect(body).toContain("1 Publisher");
	});

	test("state preservation: a sort link resets the page back to 0", async () => {
		for (let i = 1; i <= 25; i++) {
			const n = String(i).padStart(2, "0");
			await insertPublisher(ctx.db, { id: `pub-${n}`, name: `Publisher ${n}` });
		}
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		// On page 1 sorted ascending by name, clicking the (already active) name
		// header must toggle to descending and drop `p` (return to page 0).
		const res = await app.request(`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}&p=1`);
		const body = await res.text();

		expect(body).toContain(`href="/admin/resources/publishers?o=-${NAME_COLUMN_INDEX}"`);
	});

	test("state preservation: a page link keeps the current sort and filter", async () => {
		for (let i = 1; i <= 25; i++) {
			const n = String(i).padStart(2, "0");
			await insertPublisher(ctx.db, {
				id: `pub-${n}`,
				name: `Publisher ${n}`,
				status: "active",
			});
		}
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request(
			`/admin/resources/publishers?o=${NAME_COLUMN_INDEX}&status=active`,
		);
		const body = await res.text();

		expect(body).toContain(
			`href="/admin/resources/publishers?status=active&amp;o=${NAME_COLUMN_INDEX}&amp;p=1"`,
		);
	});

	test("state preservation: the search form carries the current sort and filters as hidden inputs", async () => {
		await insertPublisher(ctx.db, { id: "pub-1", name: "TKNF Books", status: "active" });
		const resource = new PublisherResource(new PublisherModel(ctx.db));
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, resources: [resource] }));

		const res = await app.request(
			`/admin/resources/publishers?o=-${NAME_COLUMN_INDEX}&status=active`,
		);
		const body = await res.text();

		expect(body).toContain(`<input type="hidden" name="o" value="-${NAME_COLUMN_INDEX}"`);
		expect(body).toContain('<input type="hidden" name="status" value="active"');
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
