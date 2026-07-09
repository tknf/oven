/**
 * Tests `AdminResource` (abstract base) and `fieldsFromTable` (`src/admin/admin_resource.ts`).
 * Resource CRUD wiring (route generation / screens) is covered in Step 3b, so this file only
 * verifies the core abstraction's standalone behavior (column resolution, search condition
 * assembly, form field derivation).
 */
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SQL } from "drizzle-orm";
import { describe, expect, test } from "vite-plus/test";
import { AdminResource, fieldsFromTable } from "../../src/admin/admin_resource.js";
import type { AdminModel } from "../../src/admin/admin_resource.js";
import type { Form } from "../../src/form/form.js";

/** Minimal fixture table for testing (used to verify `fieldsFromTable`/`AdminResource#columns`). */
const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	title: text("title").notNull(),
	status: text("status", { enum: ["draft", "published"] }).notNull(),
	views: integer("views"),
	createdAt: integer("created_at").notNull(),
});

/** Dummy for `AdminResource#model` (an unimplemented stub is fine since tests never call it). */
const dummyModel: AdminModel = {
	paginate: () => Promise.reject(new Error("not used")),
	listPage: () => Promise.reject(new Error("not used")),
	retrieve: () => Promise.reject(new Error("not used")),
	create: () => Promise.reject(new Error("not used")),
	update: () => Promise.reject(new Error("not used")),
	delete: () => Promise.reject(new Error("not used")),
	count: () => Promise.reject(new Error("not used")),
};

/** Minimal read-only (no `form` implementation) `AdminResource` subclass. */
class ReadOnlyItemsResource extends AdminResource {
	get key() {
		return "items";
	}
	get label() {
		return "Item";
	}
	get model() {
		return dummyModel;
	}
	get table() {
		return items;
	}
	get primaryKey() {
		return "id";
	}
}

/** Writable (`form` implemented) `AdminResource` subclass. Also exercises column overrides. */
class WritableItemsResource extends AdminResource {
	get key() {
		return "items";
	}
	get label() {
		return "Item";
	}
	get model() {
		return dummyModel;
	}
	get table() {
		return items;
	}
	get primaryKey() {
		return "id";
	}
	listColumns() {
		return ["title", "status"];
	}
	exclude() {
		return ["status"];
	}
	searchColumns() {
		return ["title"];
	}
	form(): Form<never> {
		throw new Error("not used");
	}
}

describe("fieldsFromTable", () => {
	test("the primary key column and createdAt column are excluded by default", () => {
		const fields = fieldsFromTable(items);
		expect(Object.keys(fields)).not.toContain("id");
		expect(Object.keys(fields)).not.toContain("createdAt");
	});

	test("an enum column has the select widget and options", () => {
		const fields = fieldsFromTable(items);
		expect(fields.status).toMatchObject({
			widget: "select",
			options: [
				{ value: "draft", label: "draft" },
				{ value: "published", label: "published" },
			],
		});
	});

	test("an integer column becomes input[number] and a text column becomes input[text]", () => {
		const fields = fieldsFromTable(items);
		expect(fields.views).toMatchObject({ widget: "input", type: "number" });
		expect(fields.title).toMatchObject({ widget: "input", type: "text" });
	});

	test("a notNull column becomes required: true", () => {
		const fields = fieldsFromTable(items);
		expect(fields.title.required).toBe(true);
		expect(fields.views.required).toBe(false);
	});

	test("omit can exclude additional columns", () => {
		const fields = fieldsFromTable(items, { omit: ["status"] });
		expect(Object.keys(fields)).not.toContain("status");
	});

	test("overrides fully replaces a column definition", () => {
		const fields = fieldsFromTable(items, {
			overrides: { title: { label: "Title", widget: "textarea", rows: 4 } },
		});
		expect(fields.title).toEqual({ label: "Title", widget: "textarea", rows: 4 });
	});

	test("exclusion (default/omit) takes precedence over overrides", () => {
		const fields = fieldsFromTable(items, {
			omit: ["status"],
			overrides: { status: { label: "Status", widget: "checkbox" } },
		});
		expect(Object.keys(fields)).not.toContain("status");
	});
});

describe("AdminResource", () => {
	test("returns all columns in definition order when listColumns/exclude are not specified", () => {
		const resource = new ReadOnlyItemsResource();
		expect(resource.columns().map((c) => c.name)).toEqual([
			"id",
			"title",
			"status",
			"views",
			"createdAt",
		]);
	});

	test("returns the columns in that order and excludes the excluded ones when listColumns is specified", () => {
		const resource = new WritableItemsResource();
		expect(resource.columns().map((c) => c.name)).toEqual(["title"]);
	});

	test("throws when listColumns specifies a column name that does not exist", () => {
		class BrokenResource extends ReadOnlyItemsResource {
			listColumns() {
				return ["nope"];
			}
		}
		expect(() => new BrokenResource().columns()).toThrow();
	});

	test("searchWhere returns undefined when searchColumns is not specified or query is an empty string", () => {
		const readOnly = new ReadOnlyItemsResource();
		expect(readOnly.searchWhere("foo")).toBeUndefined();

		const writable = new WritableItemsResource();
		expect(writable.searchWhere("")).toBeUndefined();
	});

	test("returns SQL when searchColumns is specified", () => {
		const writable = new WritableItemsResource();
		expect(writable.searchWhere("foo")).toBeInstanceOf(SQL);
	});

	test("canWrite is determined by whether form is implemented", () => {
		expect(new ReadOnlyItemsResource().canWrite()).toBe(false);
		expect(new WritableItemsResource().canWrite()).toBe(true);
	});
});
