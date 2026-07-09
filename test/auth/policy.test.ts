/**
 * Tests `Policy` (the abstract base for authorization) (docs/testing.md L1). Verifies
 * that `authorize` accepts both a boolean and a `Promise<boolean>` and throws
 * `HTTPException` on denial, the default `denyStatus` of 404 and a subclass overriding
 * it to 403, and an integration case wired into a Hono app (deny -> 404 response).
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, test } from "vite-plus/test";
import { ErrorPages } from "../../src/routing/error_handler.js";
import { Policy } from "../../src/auth/policy.js";

type Account = { id: string };
type Book = { ownerId: string };

/** Test policy that only has `canUpdate`, keeping the default `denyStatus` (404). */
class BookPolicy extends Policy {
	readonly canUpdate = (user: Account, book: Book): boolean => user.id === book.ownerId;
}

/** Test policy that overrides `denyStatus` to 403. */
class ExplicitDenyBookPolicy extends Policy {
	protected override get denyStatus(): 403 | 404 {
		return 403;
	}

	readonly canUpdate = (user: Account, book: Book): boolean => user.id === book.ownerId;
}

const buildAccount = (id = "acc_1"): Account => ({ id });
const buildBook = (ownerId = "acc_1"): Book => ({ ownerId });

describe("Policy", () => {
	test("authorize resolves without doing anything when ability is true", async () => {
		const policy = new BookPolicy();
		const user = buildAccount();
		const book = buildBook();

		await expect(policy.authorize(policy.canUpdate(user, book))).resolves.toBeUndefined();
	});

	test("authorize throws HTTPException with the default status of 404 when ability is false", async () => {
		const policy = new BookPolicy();
		const user = buildAccount("acc_2");
		const book = buildBook("acc_1");

		await expect(policy.authorize(policy.canUpdate(user, book))).rejects.toMatchObject({
			status: 404,
		});
	});

	test("a subclass that overrides denyStatus to 403 throws HTTPException with 403", async () => {
		const policy = new ExplicitDenyBookPolicy();
		const user = buildAccount("acc_2");
		const book = buildBook("acc_1");

		await expect(policy.authorize(policy.canUpdate(user, book))).rejects.toMatchObject({
			status: 403,
		});
	});

	test("authorize also accepts a Promise<boolean>", async () => {
		const policy = new BookPolicy();
		const user = buildAccount("acc_2");
		const book = buildBook("acc_1");

		await expect(
			policy.authorize(Promise.resolve(policy.canUpdate(user, book))),
		).rejects.toBeInstanceOf(HTTPException);
	});

	test("wiring into a Hono app yields a 404 response when ability is denied", async () => {
		const policy = new BookPolicy();
		const errors = new ErrorPages();

		const app = new Hono();
		app.onError(errors.onError);
		app.get("/books/:id", async (c) => {
			const user = buildAccount("acc_2");
			const book = buildBook("acc_1");
			await policy.authorize(policy.canUpdate(user, book));
			return c.text("ok");
		});

		const res = await app.request("/books/1");

		expect(res.status).toBe(404);
	});
});
