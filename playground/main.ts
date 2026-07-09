/**
 * Committed Vite-based playground for exercising the admin panel locally.
 * Unlike a throwaway script, this file is part of the repo and is covered by
 * `vp check` / `vp run typecheck`, but it is not published (see `files` in
 * `package.json`) and is not covered by `src`/`test`/`docs`.
 *
 * Start it from the repo root with:
 *   vp run playground
 * then open http://localhost:8787/admin (or http://localhost:8787/, which
 * redirects there). Since `auth` is wired below, that first request bounces
 * to /admin/login — sign in with admin/secret.
 *
 * To tweak the visual style, edit `ADMIN_CSS` in `src/admin/admin_styles.ts`
 * and save — Vite's dev server hot-reloads the module, so a browser refresh
 * picks up the change.
 *
 * The DB is an in-memory libSQL instance seeded with a handful of publisher,
 * job, and audit-log rows so every screen (dashboard, resource CRUD, jobs,
 * settings, audit log) has content to render. Feature flags and maintenance
 * mode run against an in-memory `KeyValueStore`. Writes made through the
 * admin forms are not persisted anywhere outside this process, and the data
 * resets whenever the dev server restarts.
 *
 * Pages to try:
 *   /admin
 *   /admin/resources/publishers
 *   /admin/resources/publishers/pub-1/edit
 *   /admin/jobs
 *   /admin/settings
 *   /admin/audit
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Env } from "hono";
import { Hono } from "hono";
import { AdminPanel } from "../src/admin/admin_panel.js";
import type { AdminInline } from "../src/admin/admin_resource.js";
import { AdminResource, fieldsFromTable } from "../src/admin/admin_resource.js";
import { SQLiteAuditLog } from "../src/audit/sqlite_audit_log.js";
import type { FieldDef } from "../src/form/form.js";
import { Form } from "../src/form/form.js";
import { SQLiteJobsConsole } from "../src/jobs/sqlite_jobs_console.js";
import { FeatureFlags } from "../src/kv/feature_flags.js";
import { InMemoryKeyValueStore } from "../src/kv/in_memory_key_value_store.js";
import { SQLiteModel } from "../src/model/sqlite_model.js";
import { MaintenanceMode } from "../src/security/maintenance_mode.js";
import { InMemorySessionStorage } from "../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../src/session/session_accessor.js";
import type { Session } from "../src/session/session.js";
import { createTestDb } from "../src/test/db.js";
import * as schema from "../test/test_support/fixtures/schema.js";

/** Session variable binding, so the flash message banner has somewhere to persist to. */
type PreviewEnv = Env & { Variables: { session: Session } };

const migrationsFolder = new URL("../test/test_support/fixtures/migrations", import.meta.url)
	.pathname;

/** Minimal Standard Schema implementation, copied from `test/admin/admin_resource_panel.test.ts`. */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-playground",
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

/** Real `SQLiteModel` subclass that operates on the `books` table, the child side of the `publishers` inline. */
class BookModel extends SQLiteModel<typeof schema.books, typeof schema.books.id, typeof schema> {
	protected get table() {
		return schema.books;
	}
	protected get primaryKey() {
		return schema.books.id;
	}
}

type BookInput = { title: string };

/** Inline child form for `books`, whose only editable field is `title`. */
class BookForm extends Form<StandardSchemaV1<unknown, BookInput>, string> {
	protected schema() {
		return defineStubSchema<BookInput>((value) => {
			const record = value as Record<string, unknown>;
			if (typeof record.title !== "string" || record.title === "") {
				return { issues: [{ message: "Title is required", path: ["title"] }] };
			}
			return { value: { title: record.title } };
		});
	}
	protected fields(): Record<string, FieldDef> {
		return fieldsFromTable(schema.books, { omit: ["publisherId"] });
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

/** Writable `publishers` resource, with a `books` tabular inline. */
class PublisherResource extends AdminResource {
	constructor(
		private readonly publisherModel: PublisherModel,
		private readonly bookModel: BookModel,
	) {
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
	dateHierarchy() {
		return "createdAt";
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
	inlines(): AdminInline[] {
		return [
			{
				key: "books",
				label: "Books",
				model: this.bookModel,
				table: schema.books,
				primaryKey: "id",
				foreignKey: "publisherId",
				form: () => new BookForm(),
				extra: 2,
			},
		];
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

/**
 * Seed data: enough rows (more than the list screen's page size of 20) to see
 * both the sortable column headers and the numbered pagination in the
 * `publishers` list. `createdAt` is spread across several months of 2023 and
 * 2024 (rather than left at "now") so `PublisherResource#dateHierarchy()`'s
 * year -> month -> day drilldown has more than one year/month to show.
 */
const SEED_PUBLISHERS = [
	{ id: "pub-1", name: "TKNF Books", status: "active", createdAt: Date.UTC(2023, 0, 5) },
	{ id: "pub-2", name: "Another Press", status: "active", createdAt: Date.UTC(2023, 0, 20) },
	{ id: "pub-3", name: "Riverside Editions", status: "inactive", createdAt: Date.UTC(2023, 2, 3) },
	{ id: "pub-4", name: "Northwind Publishing", status: "active", createdAt: Date.UTC(2023, 5, 14) },
	{ id: "pub-5", name: "Cobalt House", status: "active", createdAt: Date.UTC(2023, 5, 28) },
	{ id: "pub-6", name: "Silverline Media", status: "inactive", createdAt: Date.UTC(2023, 8, 1) },
	{ id: "pub-7", name: "Harborview Press", status: "active", createdAt: Date.UTC(2023, 11, 25) },
	{ id: "pub-8", name: "Lantern Books", status: "active", createdAt: Date.UTC(2024, 0, 9) },
	{ id: "pub-9", name: "Granite Publishing", status: "inactive", createdAt: Date.UTC(2024, 0, 30) },
	{ id: "pub-10", name: "Willow Press", status: "active", createdAt: Date.UTC(2024, 1, 12) },
	{ id: "pub-11", name: "Cascade Editions", status: "active", createdAt: Date.UTC(2024, 3, 4) },
	{ id: "pub-12", name: "Marble Media", status: "inactive", createdAt: Date.UTC(2024, 3, 18) },
	{ id: "pub-13", name: "Sunstone Books", status: "active", createdAt: Date.UTC(2024, 6, 7) },
	{ id: "pub-14", name: "Ember Publishing", status: "active", createdAt: Date.UTC(2024, 6, 22) },
	{ id: "pub-15", name: "Driftwood Press", status: "inactive", createdAt: Date.UTC(2024, 9, 2) },
	{ id: "pub-16", name: "Cinder House", status: "active", createdAt: Date.UTC(2024, 9, 15) },
	{ id: "pub-17", name: "Foxglove Editions", status: "active", createdAt: Date.UTC(2024, 11, 6) },
	{ id: "pub-18", name: "Ironbark Media", status: "inactive", createdAt: Date.UTC(2024, 11, 19) },
	{ id: "pub-19", name: "Hollow Books", status: "active" },
	{ id: "pub-20", name: "Slate Publishing", status: "active" },
	{ id: "pub-21", name: "Meridian Press", status: "inactive" },
	{ id: "pub-22", name: "Thistle House", status: "active" },
	{ id: "pub-23", name: "Amber Editions", status: "active" },
];

/** Inserts one row into the `books` table. */
const insertBook = async (
	db: Awaited<ReturnType<typeof createTestDb<typeof schema>>>["db"],
	overrides: Partial<typeof schema.books.$inferInsert> &
		Pick<typeof schema.books.$inferInsert, "id" | "publisherId" | "title">,
) => {
	const now = Date.now();
	await db.insert(schema.books).values({
		createdAt: overrides.createdAt ?? now,
		updatedAt: overrides.updatedAt ?? now,
		...overrides,
	});
};

/** Seed data for the `publishers` inline: a couple of books for the first few publishers. */
const SEED_BOOKS = [
	{ id: "book-1", publisherId: "pub-1", title: "The Oven Cookbook" },
	{ id: "book-2", publisherId: "pub-1", title: "Convention Over Configuration" },
	{ id: "book-3", publisherId: "pub-2", title: "Another Press Anthology" },
];

/** Inserts one row into the `jobs` table (same column set as `insertJob` in `test/admin/admin_panel.test.ts`). */
const insertJob = async (
	db: Awaited<ReturnType<typeof createTestDb<typeof schema>>>["db"],
	overrides: Partial<typeof schema.jobs.$inferInsert> &
		Pick<typeof schema.jobs.$inferInsert, "id" | "name" | "payload">,
) => {
	const now = Date.now();
	await db.insert(schema.jobs).values({
		runAt: overrides.runAt ?? now,
		priority: overrides.priority ?? 0,
		attempts: overrides.attempts ?? 0,
		lockedAt: overrides.lockedAt ?? null,
		failedAt: overrides.failedAt ?? null,
		lastError: overrides.lastError ?? null,
		createdAt: overrides.createdAt ?? now,
		...overrides,
	});
};

/**
 * Seed data for the jobs screen: a mix of pending (not yet run), locked (currently
 * running), and failed rows so both `AdminJobsView` tables have content.
 */
const SEED_JOBS = [
	{ id: "job-1", name: "SendWelcomeEmail", payload: "{}" },
	{ id: "job-2", name: "SendReminder", payload: "{}", priority: 5 },
	{ id: "job-3", name: "SyncInventory", payload: "{}", lockedAt: Date.now() },
	{
		id: "job-4",
		name: "GenerateInvoice",
		payload: "{}",
		attempts: 3,
		failedAt: Date.now(),
		lastError: "Timed out contacting billing service",
	},
	{
		id: "job-5",
		name: "SendReminder",
		payload: "{}",
		attempts: 1,
		failedAt: Date.now() - 60_000,
		lastError: "Invalid recipient address",
	},
];

/** Seed data for the audit log screen: a handful of varied actors/actions/targets. */
const SEED_AUDITS: { actor: string; action: string; target: string; changes?: unknown }[] = [
	{ actor: "admin", action: "publishers.create", target: "pub-1", changes: { name: "TKNF Books" } },
	{
		actor: "admin",
		action: "publishers.update",
		target: "pub-3",
		changes: { status: "inactive" },
	},
	{ actor: "admin", action: "settings.maintenance.enable", target: "maintenance" },
	{ actor: "admin", action: "settings.flags.enable", target: "beta" },
	{ actor: "admin", action: "jobs.retry", target: "job-4" },
];

const ctx = await createTestDb({ schema, migrationsFolder });
for (const seed of SEED_PUBLISHERS) {
	await insertPublisher(ctx.db, seed);
}
for (const seed of SEED_BOOKS) {
	await insertBook(ctx.db, seed);
}
for (const seed of SEED_JOBS) {
	await insertJob(ctx.db, seed);
}

const auditLog = new SQLiteAuditLog(ctx.db, schema.audits);
for (const seed of SEED_AUDITS) {
	await auditLog.record(seed);
}

const featureFlags = new FeatureFlags(new InMemoryKeyValueStore());
await featureFlags.enable("beta");
await featureFlags.disable("new-dashboard");

const publisherResource = new PublisherResource(new PublisherModel(ctx.db), new BookModel(ctx.db));

const sessionAccessor = new SessionAccessor<PreviewEnv, "session">(
	"session",
	new InMemorySessionStorage(),
);

const app = new Hono<PreviewEnv>();
app.get("/", (c) => c.redirect("/admin"));
app.use(sessionAccessor.register);
app.route(
	"/admin",
	new AdminPanel<PreviewEnv>({
		brand: "oven admin (playground)",
		authorize: () => true,
		resources: [publisherResource],
		jobs: { console: new SQLiteJobsConsole(ctx.db, schema.jobs) },
		settings: {
			featureFlags: { flags: featureFlags, names: ["beta", "new-dashboard"] },
			maintenance: new MaintenanceMode(new InMemoryKeyValueStore()),
		},
		audit: { log: auditLog },
		session: sessionAccessor.use,
		auth: {
			authenticate: async (_c, { username, password }) =>
				username === "admin" && password === "secret" ? { id: "admin", label: "admin" } : null,
		},
	}),
);

export default app;
