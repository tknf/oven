/**
 * Verifies `defineFactory`, the test data factory provided by `@tknf/oven/test`.
 * Checks default value application, overrides taking precedence, sequence progression,
 * delegation to persistence, and reset behavior.
 */
import { describe, expect, test } from "vite-plus/test";
import { defineFactory } from "../../src/test/factory.js";

type BookInput = { title: string; status: "draft" | "published" };
type BookRow = BookInput & { id: number };

describe("defineFactory", () => {
	test("build returns input with defaults applied", () => {
		const factory = defineFactory<BookInput, BookRow>(
			async (input) => ({ id: 1, ...input }),
			(seq) => ({ title: `Book ${seq}`, status: "draft" }),
		);

		expect(factory.build()).toEqual({ title: "Book 1", status: "draft" });
	});

	test("overrides take precedence over defaults", () => {
		const factory = defineFactory<BookInput, BookRow>(
			async (input) => ({ id: 1, ...input }),
			(seq) => ({ title: `Book ${seq}`, status: "draft" }),
		);

		expect(factory.build({ status: "published" })).toEqual({
			title: "Book 1",
			status: "published",
		});
	});

	test("seq advances 1, 2, 3 with each build", () => {
		const factory = defineFactory<BookInput, BookRow>(
			async (input) => ({ id: 1, ...input }),
			(seq) => ({ title: `Book ${seq}`, status: "draft" }),
		);

		expect(factory.build().title).toBe("Book 1");
		expect(factory.build().title).toBe("Book 2");
		expect(factory.build().title).toBe("Book 3");
	});

	test("create passes the built input to persist and returns its return value", async () => {
		const persisted: BookInput[] = [];
		const factory = defineFactory<BookInput, BookRow>(
			async (input) => {
				persisted.push(input);
				return { id: persisted.length, ...input };
			},
			(seq) => ({ title: `Book ${seq}`, status: "draft" }),
		);

		const row = await factory.create({ status: "published" });

		expect(persisted).toEqual([{ title: "Book 1", status: "published" }]);
		expect(row).toEqual({ id: 1, title: "Book 1", status: "published" });
	});

	test("reset returns seq back to 0", () => {
		const factory = defineFactory<BookInput, BookRow>(
			async (input) => ({ id: 1, ...input }),
			(seq) => ({ title: `Book ${seq}`, status: "draft" }),
		);
		factory.build();
		factory.build();

		factory.reset();

		expect(factory.build().title).toBe("Book 1");
	});
});
