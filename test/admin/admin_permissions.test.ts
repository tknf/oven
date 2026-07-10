/**
 * Tests the permission-string vocabulary for admin-panel operator accounts
 * (`src/admin/admin_permissions.ts`): the `resourcePermission`/`resourcePermissions`
 * builders and the tolerant `parseStoredPermissions` parser for the stored JSON
 * TEXT column.
 */
import { describe, expect, test } from "vite-plus/test";
import {
	ADMIN_PERMISSION_ACTIONS,
	parseStoredPermissions,
	resourcePermission,
	resourcePermissions,
} from "../../src/admin/admin_permissions.js";

describe("resourcePermission", () => {
	test("builds resource.<key>.<action>", () => {
		expect(resourcePermission("items", "view")).toBe("resource.items.view");
		expect(resourcePermission("items", "delete")).toBe("resource.items.delete");
	});
});

describe("resourcePermissions", () => {
	test("returns all four action permissions for one resource key", () => {
		expect(resourcePermissions("items")).toEqual([
			"resource.items.view",
			"resource.items.create",
			"resource.items.update",
			"resource.items.delete",
		]);
	});

	test("covers exactly the actions in ADMIN_PERMISSION_ACTIONS", () => {
		expect(ADMIN_PERMISSION_ACTIONS).toEqual(["view", "create", "update", "delete"]);
		expect(resourcePermissions("books")).toHaveLength(ADMIN_PERMISSION_ACTIONS.length);
	});
});

describe("parseStoredPermissions", () => {
	test("parses a stored JSON array of strings", () => {
		expect(parseStoredPermissions('["resource.items.view","jobs.manage"]')).toEqual([
			"resource.items.view",
			"jobs.manage",
		]);
		expect(parseStoredPermissions("[]")).toEqual([]);
	});

	test("returns [] for invalid JSON", () => {
		expect(parseStoredPermissions("not json")).toEqual([]);
		expect(parseStoredPermissions("")).toEqual([]);
	});

	test("returns [] for JSON that is not an array", () => {
		expect(parseStoredPermissions('{"resource.items.view":true}')).toEqual([]);
		expect(parseStoredPermissions('"resource.items.view"')).toEqual([]);
		expect(parseStoredPermissions("42")).toEqual([]);
		expect(parseStoredPermissions("null")).toEqual([]);
	});

	test("drops non-string members of an otherwise valid array", () => {
		expect(parseStoredPermissions('["audit.view",1,null,{"x":1},"jobs.view"]')).toEqual([
			"audit.view",
			"jobs.view",
		]);
	});
});
