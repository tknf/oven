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
	test("attaches the suffix for each class-producing type", () => {
		expect(classNameFor("model", "book")).toBe("BookModel");
		expect(classNameFor("form", "book")).toBe("BookForm");
		expect(classNameFor("job", "SendWelcomeMail")).toBe("SendWelcomeMailJob");
		expect(classNameFor("policy", "book")).toBe("BookPolicy");
		expect(classNameFor("view", "book")).toBe("BookView");
		expect(classNameFor("admin", "book")).toBe("BookResource");
	});

	test("does not double-attach the suffix for a name that already ends with it", () => {
		expect(classNameFor("model", "BookModel")).toBe("BookModel");
		expect(classNameFor("admin", "BookResource")).toBe("BookResource");
	});
});

describe("planGeneration: routes", () => {
	test("writes routes.ts in the domain directory as a chained Hono sub-app", () => {
		const plan = planGeneration({ type: "routes", domain: "books" });
		expect(plan.filePath).toBe("src/domains/books/routes.ts");
		expect(plan.content).toContain('import { Hono } from "hono";');
		expect(plan.content).toContain("export const booksRoutes = new Hono().get(");
		expect(plan.content).toContain('app.route("/books", booksRoutes)');
	});

	test("normalizes the domain to snake_case for the directory", () => {
		const plan = planGeneration({ type: "routes", domain: "BookReviews" });
		expect(plan.filePath).toBe("src/domains/book_reviews/routes.ts");
		expect(plan.content).toContain("export const bookReviewsRoutes = new Hono()");
	});

	test("can override the output directory via the --dir equivalent", () => {
		const plan = planGeneration({ type: "routes", domain: "books", dir: "app/books" });
		expect(plan.filePath).toBe("app/books/routes.ts");
	});
});

describe("planGeneration: schema", () => {
	test("writes only the sqlite table by default", () => {
		const plan = planGeneration({ type: "schema", domain: "books", name: "book" });
		expect(plan.filePath).toBe("src/domains/books/schema.ts");
		expect(plan.content).toContain('from "drizzle-orm/sqlite-core"');
		expect(plan.content).toContain('export const book = sqliteTable("book", {');
		expect(plan.content).not.toContain("@tknf/oven");
	});

	test("uses pg-core for dialect: pg", () => {
		const plan = planGeneration({ type: "schema", domain: "books", name: "book", dialect: "pg" });
		expect(plan.content).toContain('export const book = pgTable("book", {');
	});

	test("uses mysql-core for dialect: mysql", () => {
		const plan = planGeneration({
			type: "schema",
			domain: "books",
			name: "book",
			dialect: "mysql",
		});
		expect(plan.content).toContain('export const book = mysqlTable("book", {');
	});
});

describe("planGeneration: model", () => {
	test("extends SQLiteModel by default and imports the table from ./schema.js", () => {
		const plan = planGeneration({ type: "model", domain: "books", name: "book" });
		expect(plan.filePath).toBe("src/domains/books/model.ts");
		expect(plan.content).toContain('import { SQLiteModel } from "@tknf/oven/model";');
		expect(plan.content).toContain('import { book } from "./schema.js";');
		expect(plan.content).toContain('import type * as schema from "./schema.js";');
		expect(plan.content).toContain(
			"export class BookModel extends SQLiteModel<\n\ttypeof book,\n\ttypeof book.id,\n\ttypeof schema\n> {",
		);
		expect(plan.content).not.toContain("sqliteTable");
	});

	test("uses PgModel for dialect: pg", () => {
		const plan = planGeneration({ type: "model", domain: "books", name: "book", dialect: "pg" });
		expect(plan.content).toContain('import { PgModel } from "@tknf/oven/model";');
		expect(plan.content).toContain("export class BookModel extends PgModel<");
	});

	test("uses MySqlModel for dialect: mysql", () => {
		const plan = planGeneration({
			type: "model",
			domain: "books",
			name: "book",
			dialect: "mysql",
		});
		expect(plan.content).toContain('import { MySqlModel } from "@tknf/oven/model";');
		expect(plan.content).toContain("export class BookModel extends MySqlModel<");
	});

	test("derives the class name from the domain when no name is given", () => {
		const plan = planGeneration({ type: "model", domain: "books" });
		expect(plan.content).toContain("export class BooksModel extends SQLiteModel<");
	});
});

describe("planGeneration: form", () => {
	test("returns a scaffold that extends Form and includes schema/fields TODOs", () => {
		const plan = planGeneration({ type: "form", domain: "books", name: "book" });
		expect(plan.filePath).toBe("src/domains/books/form.ts");
		expect(plan.content).toContain('import { Form } from "@tknf/oven/form";');
		expect(plan.content).toContain("export class BookForm extends Form<");
		expect(plan.content).toContain("protected schema()");
		expect(plan.content).toContain("protected fields()");
	});
});

describe("planGeneration: policy", () => {
	test("returns a scaffold that extends Policy", () => {
		const plan = planGeneration({ type: "policy", domain: "books", name: "book" });
		expect(plan.filePath).toBe("src/domains/books/policy.ts");
		expect(plan.content).toContain('import { Policy } from "@tknf/oven/auth";');
		expect(plan.content).toContain("export class BookPolicy extends Policy {");
	});
});

describe("planGeneration: view", () => {
	test("writes views/<name>.tsx with a domain-prefixed View class", () => {
		const plan = planGeneration({ type: "view", domain: "books", name: "list" });
		expect(plan.filePath).toBe("src/domains/books/views/list.tsx");
		expect(plan.content).toContain('import { View } from "@tknf/oven/view";');
		expect(plan.content).toContain("export class BooksListView extends View {");
		expect(plan.content).toContain("html(c: Context)");
	});

	test("throws when no name is given", () => {
		expect(() => planGeneration({ type: "view", domain: "books" })).toThrow(
			/The view template requires a name/,
		);
	});
});

describe("planGeneration: job", () => {
	test("writes jobs/<name>.ts with a Job<TPayload> scaffold", () => {
		const plan = planGeneration({ type: "job", domain: "books", name: "ImportBooks" });
		expect(plan.filePath).toBe("src/domains/books/jobs/import_books.ts");
		expect(plan.content).toContain('import { Job } from "@tknf/oven/jobs";');
		expect(plan.content).toContain(
			"export class ImportBooksJob extends Job<ImportBooksJobPayload>",
		);
		expect(plan.content).toContain('readonly name = "import_books";');
		expect(plan.content).toContain("async perform(payload: ImportBooksJobPayload): Promise<void>");
	});

	test("does not repeat the suffix in the file name", () => {
		const plan = planGeneration({ type: "job", domain: "books", name: "ImportBooksJob" });
		expect(plan.filePath).toBe("src/domains/books/jobs/import_books.ts");
	});

	test("throws when no name is given", () => {
		expect(() => planGeneration({ type: "job", domain: "books" })).toThrow(
			/The job template requires a name/,
		);
	});
});

describe("planGeneration: admin", () => {
	test("returns a scaffold that extends AdminResource and injects the model/table via the constructor", () => {
		const plan = planGeneration({ type: "admin", domain: "books", name: "book" });
		expect(plan.filePath).toBe("src/domains/books/admin.ts");
		expect(plan.content).toContain('import type { Table } from "drizzle-orm";');
		expect(plan.content).toContain('import type { AdminModel } from "@tknf/oven/admin";');
		expect(plan.content).toContain('import { AdminResource } from "@tknf/oven/admin";');
		expect(plan.content).toContain("export class BookResource extends AdminResource {");
		expect(plan.content).toContain(
			"private readonly bookModel: AdminModel,\n\t\tprivate readonly book: Table,",
		);
		expect(plan.content).toContain('// import { book } from "./schema.js";');
		expect(plan.content).toContain("get primaryKey(): string {");
	});

	test("does not brand the template with a dialect (AdminModel is dialect-agnostic)", () => {
		const plan = planGeneration({ type: "admin", domain: "books", name: "book" });
		expect(plan.content).not.toContain("sqlite");
		expect(plan.content).not.toContain("pg-core");
		expect(plan.content).not.toContain("mysql");
	});
});

describe("planGeneration: unknown type", () => {
	test("throws for a type outside GENERATE_TYPES, including the removed handler and seed types", () => {
		for (const type of ["unknown", "handler", "seed"]) {
			expect(() => planGeneration({ type: type as GenerateType, domain: "books" })).toThrow(
				/Unknown type/,
			);
		}
	});
});

describe("planGeneration: --dialect misuse", () => {
	test("does not throw when dialect is given for the schema and model types", () => {
		expect(() => planGeneration({ type: "schema", domain: "books", dialect: "pg" })).not.toThrow();
		expect(() => planGeneration({ type: "model", domain: "books", dialect: "pg" })).not.toThrow();
	});

	test("throws when dialect is given for a type that does not use it", () => {
		expect(() => planGeneration({ type: "routes", domain: "books", dialect: "pg" })).toThrow(
			/--dialect only applies to the schema and model templates/,
		);
		expect(() => planGeneration({ type: "admin", domain: "books", dialect: "sqlite" })).toThrow(
			/--dialect only applies to the schema and model templates/,
		);
	});
});
