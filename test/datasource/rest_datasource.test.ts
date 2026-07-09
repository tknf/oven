/**
 * Verifies `RestDatasource` (the `retrieve`/`list`/`create`/`update`/`delete`
 * convention over `Datasource` for a single REST resource). Uses a minimal
 * test subclass backed by a swappable `fetch`, plus a self-contained Standard
 * Schema stub (same approach as `datasource.test.ts`/`form.test.ts`).
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test, vi } from "vite-plus/test";
import { DatasourceValidationError } from "../../src/datasource/datasource_error.js";
import { RestDatasource } from "../../src/datasource/rest_datasource.js";

type User = { id: string; name: string };

/** Minimal Standard Schema implementation for tests. Accepts any object shaped like a `User`. */
const userSchema: StandardSchemaV1<unknown, User> = {
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate: (value: unknown) => {
			const record = value as Partial<User> | null | undefined;
			if (
				record === null ||
				record === undefined ||
				typeof record.id !== "string" ||
				typeof record.name !== "string"
			) {
				return { issues: [{ message: "expected a User", path: [] }] };
			}
			return { value: { id: record.id, name: record.name } };
		},
	},
};

class UsersDatasource extends RestDatasource<User> {
	protected get resourcePath() {
		return "/users";
	}

	protected get schema() {
		return userSchema;
	}
}

/** Same as `UsersDatasource`, but unwraps an enveloped `{ data: [...] }` list response. */
class EnvelopedUsersDatasource extends UsersDatasource {
	protected toArray(raw: unknown): unknown[] {
		const envelope = raw as { data: unknown[] };
		return envelope.data;
	}
}

/** Same as `UsersDatasource`, but `resourcePath` has a trailing slash (a common misconfiguration). */
class TrailingSlashUsersDatasource extends UsersDatasource {
	protected get resourcePath() {
		return "/users/";
	}
}

const buildUser = (overrides: Partial<User> = {}): User => ({
	id: "1",
	name: "Alice",
	...overrides,
});

const buildFetch = (body: unknown, status = 200) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

const buildDatasource = (fetchFn: typeof fetch) =>
	new UsersDatasource({ baseUrl: "https://api.example.com", fetch: fetchFn });

describe("RestDatasource", () => {
	describe("retrieve", () => {
		test("requests GET /users/:id and returns the validated entity", async () => {
			const user = buildUser();
			const fetch = buildFetch(user);
			const ds = buildDatasource(fetch);

			await expect(ds.retrieve("1")).resolves.toEqual(user);

			const [url, init] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users/1");
			expect(init?.method).toBe("GET");
		});

		test("returns undefined when the resource responds 404", async () => {
			const fetch = buildFetch("not found", 404);
			const ds = buildDatasource(fetch);

			await expect(ds.retrieve("missing")).resolves.toBeUndefined();
		});

		test("rethrows on a non-404 error status", async () => {
			const fetch = buildFetch("server error", 500);
			const ds = buildDatasource(fetch);

			await expect(ds.retrieve("1")).rejects.toMatchObject({ status: 500 });
		});

		test("URL-encodes the id", async () => {
			const fetch = buildFetch(buildUser());
			const ds = buildDatasource(fetch);

			await ds.retrieve("a/b");

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users/a%2Fb");
		});

		test("a trailing slash on resourcePath does not produce a double slash", async () => {
			const fetch = buildFetch(buildUser());
			const ds = new TrailingSlashUsersDatasource({ baseUrl: "https://api.example.com", fetch });

			await ds.retrieve("1");

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users/1");
		});
	});

	describe("list", () => {
		test("requests GET /users and returns each entity validated against the schema", async () => {
			const users = [buildUser({ id: "1" }), buildUser({ id: "2", name: "Bob" })];
			const fetch = buildFetch(users);
			const ds = buildDatasource(fetch);

			await expect(ds.list()).resolves.toEqual(users);

			const [url, init] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users");
			expect(init?.method).toBe("GET");
		});

		test("the default toArray throws on a non-array response", async () => {
			const fetch = buildFetch({ data: [buildUser()] });
			const ds = buildDatasource(fetch);

			await expect(ds.list()).rejects.toThrow(/expected a JSON array/);
		});

		test("overriding toArray unwraps an enveloped list", async () => {
			const users = [buildUser()];
			const fetch = buildFetch({ data: users });
			const ds = new EnvelopedUsersDatasource({ baseUrl: "https://api.example.com", fetch });

			await expect(ds.list()).resolves.toEqual(users);
		});

		test("an element that fails the schema throws DatasourceValidationError", async () => {
			const fetch = buildFetch([{ id: "1" }]);
			const ds = buildDatasource(fetch);

			await expect(ds.list()).rejects.toBeInstanceOf(DatasourceValidationError);
		});
	});

	describe("create", () => {
		test("requests POST /users with a JSON body and returns the validated entity", async () => {
			const user = buildUser();
			const fetch = buildFetch(user);
			const ds = buildDatasource(fetch);

			await expect(ds.create({ name: "Alice" })).resolves.toEqual(user);

			const [url, init] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users");
			expect(init?.method).toBe("POST");
			expect(init?.body).toBe(JSON.stringify({ name: "Alice" }));
		});
	});

	describe("update", () => {
		test("requests PATCH /users/:id with a JSON body and returns the validated entity", async () => {
			const user = buildUser({ name: "Alice Updated" });
			const fetch = buildFetch(user);
			const ds = buildDatasource(fetch);

			await expect(ds.update("1", { name: "Alice Updated" })).resolves.toEqual(user);

			const [url, init] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/users/1");
			expect(init?.method).toBe("PATCH");
			expect(init?.body).toBe(JSON.stringify({ name: "Alice Updated" }));
		});
	});

	describe("delete", () => {
		test("requests DELETE /users/:id and resolves to void without throwing", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
			const ds = buildDatasource(fetchFn);

			await expect(ds.delete("1")).resolves.toBeUndefined();

			const [url, init] = fetchFn.mock.calls[0];
			expect(url).toBe("https://api.example.com/users/1");
			expect(init?.method).toBe("DELETE");
		});
	});
});
