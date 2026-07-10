/**
 * Tests the scaffold generation logic used by `oven generate` (`src/cli/generate.ts`).
 * Only targets the pure functions, which never touch the filesystem.
 */
import { describe, expect, test } from "vite-plus/test";
import type { GenerateType } from "../../src/cli/generate.js";
import { classNameFor, pascalCase, planGeneration, snakeCase } from "../../src/cli/generate.js";

describe("pascalCase", () => {
	test("normalizes lowercase words to PascalCase", () => {
		expect(pascalCase("books")).toBe("Books");
	});

	test("keeps input that is already PascalCase as-is", () => {
		expect(pascalCase("BookReview")).toBe("BookReview");
	});

	test("normalizes kebab-case/snake_case input to PascalCase as well", () => {
		expect(pascalCase("book-review")).toBe("BookReview");
		expect(pascalCase("book_review")).toBe("BookReview");
	});
});

describe("snakeCase", () => {
	test("normalizes PascalCase input to snake_case", () => {
		expect(snakeCase("BookReview")).toBe("book_review");
	});

	test("lowercases a single word as-is", () => {
		expect(snakeCase("Books")).toBe("books");
		expect(snakeCase("books")).toBe("books");
	});
});

describe("classNameFor", () => {
	test("attaches the suffix for each type", () => {
		expect(classNameFor("handler", "books")).toBe("BooksHandler");
		expect(classNameFor("model", "book")).toBe("BookModel");
		expect(classNameFor("form", "book")).toBe("BookForm");
		expect(classNameFor("job", "SendWelcomeMail")).toBe("SendWelcomeMailJob");
		expect(classNameFor("policy", "book")).toBe("BookPolicy");
		expect(classNameFor("view", "book")).toBe("BookView");
		expect(classNameFor("seed", "demo_books")).toBe("DemoBooksSeed");
	});

	test("does not double-attach the suffix for a name that already ends with it", () => {
		expect(classNameFor("handler", "BooksHandler")).toBe("BooksHandler");
	});
});

describe("planGeneration: handler", () => {
	test("returns the default output path and a RouteHandler-extending scaffold", () => {
		const plan = planGeneration({ type: "handler", name: "books" });
		expect(plan.filePath).toBe("src/handlers/books_handler.ts");
		expect(plan.content).toContain('import { RouteHandler } from "@tknf/oven/routing";');
		expect(plan.content).toContain("export class BooksHandler extends RouteHandler {");
		expect(plan.content).toContain("protected register(): void {");
	});

	test("can override the output path via the --dir equivalent", () => {
		const plan = planGeneration({ type: "handler", name: "books", dir: "app/handlers" });
		expect(plan.filePath).toBe("app/handlers/books_handler.ts");
	});
});

describe("planGeneration: model", () => {
	test("extends SQLiteModel by default (sqlite)", () => {
		const plan = planGeneration({ type: "model", name: "book" });
		expect(plan.filePath).toBe("src/models/book_model.ts");
		expect(plan.content).toContain('from "drizzle-orm/sqlite-core"');
		expect(plan.content).toContain('import { SQLiteModel } from "@tknf/oven/model";');
		expect(plan.content).toContain(
			"export class BookModel extends SQLiteModel<typeof book, typeof book.id>",
		);
	});

	test("uses PgModel and the pg-core import for dialect: pg", () => {
		const plan = planGeneration({ type: "model", name: "book", dialect: "pg" });
		expect(plan.content).toContain('from "drizzle-orm/pg-core"');
		expect(plan.content).toContain('import { PgModel } from "@tknf/oven/model";');
		expect(plan.content).toContain("export class BookModel extends PgModel<");
	});

	test("uses MySqlModel and the mysql-core import for dialect: mysql", () => {
		const plan = planGeneration({ type: "model", name: "book", dialect: "mysql" });
		expect(plan.content).toContain('from "drizzle-orm/mysql-core"');
		expect(plan.content).toContain('import { MySqlModel } from "@tknf/oven/model";');
		expect(plan.content).toContain("export class BookModel extends MySqlModel<");
	});
});

describe("planGeneration: form", () => {
	test("returns a scaffold that extends Form and includes schema/fields TODOs", () => {
		const plan = planGeneration({ type: "form", name: "book" });
		expect(plan.filePath).toBe("src/forms/book_form.ts");
		expect(plan.content).toContain('import { Form } from "@tknf/oven/form";');
		expect(plan.content).toContain("export class BookForm extends Form<");
		expect(plan.content).toContain("protected schema()");
		expect(plan.content).toContain("protected fields()");
	});
});

describe("planGeneration: job", () => {
	test("returns a scaffold that extends Job<TPayload> and includes name/perform", () => {
		const plan = planGeneration({ type: "job", name: "SendWelcomeMail" });
		expect(plan.filePath).toBe("src/jobs/send_welcome_mail_job.ts");
		expect(plan.content).toContain('import { Job } from "@tknf/oven/jobs";');
		expect(plan.content).toContain(
			"export class SendWelcomeMailJob extends Job<SendWelcomeMailJobPayload>",
		);
		expect(plan.content).toContain('readonly name = "send_welcome_mail";');
		expect(plan.content).toContain(
			"async perform(payload: SendWelcomeMailJobPayload): Promise<void>",
		);
	});
});

describe("planGeneration: policy", () => {
	test("returns a scaffold that extends Policy", () => {
		const plan = planGeneration({ type: "policy", name: "book" });
		expect(plan.filePath).toBe("src/policies/book_policy.ts");
		expect(plan.content).toContain('import { Policy } from "@tknf/oven/auth";');
		expect(plan.content).toContain("export class BookPolicy extends Policy {");
	});
});

describe("planGeneration: view", () => {
	test("returns a scaffold that extends View and includes an html() override example", () => {
		const plan = planGeneration({ type: "view", name: "book" });
		expect(plan.filePath).toBe("src/views/book_view.ts");
		expect(plan.content).toContain('import { View } from "@tknf/oven/view";');
		expect(plan.content).toContain("export class BookView extends View {");
		expect(plan.content).toContain("html(c: Context)");
	});
});

describe("planGeneration: seed", () => {
	test("returns a scaffold with no execution harness (a run function export)", () => {
		const plan = planGeneration({ type: "seed", name: "demo_books" });
		expect(plan.filePath).toBe("src/seeds/demo_books_seed.ts");
		expect(plan.content).toContain("export const runDemoBooksSeed = async (): Promise<void> => {");
	});

	test("can override the output path via the --dir equivalent", () => {
		const plan = planGeneration({ type: "seed", name: "demo_books", dir: "app/seeds" });
		expect(plan.filePath).toBe("app/seeds/demo_books_seed.ts");
	});

	test("does not double-attach the suffix for a name that already ends with it", () => {
		const plan = planGeneration({ type: "seed", name: "DemoSeed" });
		expect(plan.filePath).toBe("src/seeds/demo_seed.ts");
		expect(plan.content).toContain("export const runDemoSeed = async (): Promise<void> => {");
	});
});

describe("planGeneration: admin-resource", () => {
	test("returns a scaffold that extends AdminResource and injects the model/table via the constructor", () => {
		const plan = planGeneration({ type: "admin-resource", name: "book" });
		expect(plan.filePath).toBe("src/admin/book_resource.ts");
		expect(plan.content).toContain('import type { Table } from "drizzle-orm";');
		expect(plan.content).toContain('import type { AdminModel } from "@tknf/oven/admin";');
		expect(plan.content).toContain('import { AdminResource } from "@tknf/oven/admin";');
		expect(plan.content).toContain("export class BookResource extends AdminResource {");
		expect(plan.content).toContain(
			"private readonly bookModel: AdminModel,\n\t\tprivate readonly book: Table,",
		);
		expect(plan.content).toContain("get key(): string {");
		expect(plan.content).toContain("get label(): string {");
		expect(plan.content).toContain("get model(): AdminModel {");
		expect(plan.content).toContain("get table(): Table {");
		expect(plan.content).toContain("get primaryKey(): string {");
	});

	test("does not double-attach the suffix for a name that already ends with it", () => {
		expect(classNameFor("admin-resource", "BookResource")).toBe("BookResource");
	});

	test("does not brand the template with a dialect (AdminModel is dialect-agnostic)", () => {
		const plan = planGeneration({ type: "admin-resource", name: "book" });
		expect(plan.content).not.toContain("sqlite");
		expect(plan.content).not.toContain("pg-core");
		expect(plan.content).not.toContain("mysql");
	});
});

describe("planGeneration: unknown type", () => {
	test("throws when passed an unknown type", () => {
		expect(() =>
			planGeneration({
				type: "unknown" as GenerateType,
				name: "book",
			}),
		).toThrow(/Unknown type/);
	});
});

describe("planGeneration: --dialect misuse", () => {
	test("does not throw when dialect is given for the model type", () => {
		expect(() => planGeneration({ type: "model", name: "book", dialect: "pg" })).not.toThrow();
	});

	test("throws when dialect is given for a type that does not use it", () => {
		expect(() => planGeneration({ type: "handler", name: "books", dialect: "pg" })).toThrow(
			/--dialect only applies to the model template/,
		);
	});

	test("throws when dialect is given for the admin-resource type", () => {
		expect(() =>
			planGeneration({ type: "admin-resource", name: "book", dialect: "sqlite" }),
		).toThrow(/--dialect only applies to the model template/);
	});
});
