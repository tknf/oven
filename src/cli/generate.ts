/**
 * Template generation logic used by `oven generate` (pure functions, no side effects).
 * Actual file writing is handled by `src/cli/index.ts`.
 */
import { join } from "node:path";

/** Kinds of templates accepted by `oven generate`. */
export type GenerateType = "handler" | "model" | "form" | "job" | "policy" | "view" | "seed";

/** Drizzle dialect targeted by the `model` template. */
export type ModelDialect = "sqlite" | "pg" | "mysql";

/** Input to `planGeneration`. */
export type GenerateOptions = {
	type: GenerateType;
	name: string;
	dir?: string;
	dialect?: ModelDialect;
};

/** Output of `planGeneration`: the destination path and the file content to generate. */
export type GenerationPlan = {
	filePath: string;
	content: string;
};

/** List of types accepted by `oven generate` (keep in sync with `GenerateType`). */
export const GENERATE_TYPES: readonly GenerateType[] = [
	"handler",
	"model",
	"form",
	"job",
	"policy",
	"view",
	"seed",
];

/** Default output directory per type. */
const DEFAULT_DIRS: Record<GenerateType, string> = {
	handler: "src/handlers",
	model: "src/models",
	form: "src/forms",
	job: "src/jobs",
	policy: "src/policies",
	view: "src/views",
	seed: "src/seeds",
};

/** Class name suffix per type. */
const TYPE_SUFFIXES: Record<GenerateType, string> = {
	handler: "Handler",
	model: "Model",
	form: "Form",
	job: "Job",
	policy: "Policy",
	view: "View",
	seed: "Seed",
};

/** Splits `input` into a sequence of words (on `-`/`_`/whitespace delimiters and camelCase/PascalCase boundaries). */
const splitWords = (input: string): string[] => {
	const chunks = input.split(/[^a-zA-Z0-9]+/).filter((chunk) => chunk.length > 0);
	return chunks.flatMap(
		(chunk) => chunk.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) ?? [chunk],
	);
};

/** Normalizes `input` to PascalCase (e.g. `books` -> `Books`, `book_review` -> `BookReview`). */
export const pascalCase = (input: string): string =>
	splitWords(input)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join("");

/** Normalizes `input` to snake_case (e.g. `BookReview` -> `book_review`). */
export const snakeCase = (input: string): string =>
	splitWords(input)
		.map((word) => word.toLowerCase())
		.join("_");

/**
 * Returns the PascalCase class name with the `type` suffix appended. If `name` already
 * ends with the suffix, it is not appended twice (e.g. `BooksHandler` stays `BooksHandler`).
 */
export const classNameFor = (type: GenerateType, name: string): string => {
	const base = pascalCase(name);
	const suffix = TYPE_SUFFIXES[type];
	return base.endsWith(suffix) ? base : `${base}${suffix}`;
};

/** Strips the suffix from `className` to get the base name (used for table variable names, job names, etc.). */
const stripSuffix = (type: GenerateType, className: string): string => {
	const suffix = TYPE_SUFFIXES[type];
	return className.endsWith(suffix) ? className.slice(0, -suffix.length) : className;
};

/** Lowercases only the first character of PascalCase `word` (camelCase conversion). */
const toCamelCase = (word: string): string =>
	word.length === 0 ? word : word.charAt(0).toLowerCase() + word.slice(1);

/** Builds the handler template content. Extends `RouteHandler` and implements `register()`. */
const handlerTemplate = (
	className: string,
): string => `import { RouteHandler } from "@tknf/oven/routing";

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends RouteHandler {
	/** Registers routes. */
	protected register(): void {
		this.get("/", (c) => {
			// TODO: implement
			return c.text("TODO");
		});
	}
}
`;

/** Builds the model template content (imports, table definition, and base class differ per dialect). */
const modelTemplate = (className: string, base: string, dialect: ModelDialect): string => {
	const tableVar = toCamelCase(base);
	const tableName = snakeCase(base);

	if (dialect === "pg") {
		return `import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { PgModel } from "@tknf/oven/model";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = pgTable("${tableName}", {
	id: text("id").primaryKey(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * TODO: Describe ${className}.
 * \`PostgresJsQueryResultHKT\` is the default for the \`postgres-js\` driver. Change the type
 * argument to match the driver you use (Neon, PGlite, etc.).
 */
export class ${className} extends PgModel<
	typeof ${tableVar},
	typeof ${tableVar}.id,
	PostgresJsQueryResultHKT
> {
	protected get table() {
		return ${tableVar};
	}
	protected get primaryKey() {
		return ${tableVar}.id;
	}
}
`;
	}

	if (dialect === "mysql") {
		return `import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import type { MySql2PreparedQueryHKT, MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import { MySqlModel } from "@tknf/oven/model";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = mysqlTable("${tableName}", {
	id: varchar("id", { length: 255 }).primaryKey(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * TODO: Describe ${className}.
 * \`MySql2QueryResultHKT\`/\`MySql2PreparedQueryHKT\` are the defaults for the \`mysql2\` driver.
 * Change the type arguments if you use a different driver such as PlanetScale.
 */
export class ${className} extends MySqlModel<
	typeof ${tableVar},
	typeof ${tableVar}.id,
	MySql2QueryResultHKT,
	MySql2PreparedQueryHKT
> {
	protected get table() {
		return ${tableVar};
	}
	protected get primaryKey() {
		return ${tableVar}.id;
	}
}
`;
	}

	return `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SQLiteModel } from "@tknf/oven/model";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = sqliteTable("${tableName}", {
	id: text("id").primaryKey(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends SQLiteModel<typeof ${tableVar}, typeof ${tableVar}.id> {
	protected get table() {
		return ${tableVar};
	}
	protected get primaryKey() {
		return ${tableVar}.id;
	}
}
`;
};

/** Builds the form template content. Extends `Form` and implements `schema()`/`fields()`. */
const formTemplate = (
	className: string,
): string => `import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { FieldDef } from "@tknf/oven/form";
import { Form } from "@tknf/oven/form";

/** TODO: Define the output type validated by this form. */
type ${className}Output = Record<string, unknown>;

/**
 * TODO: Describe ${className}.
 * \`schema()\` may return any library that conforms to Standard Schema
 * (https://standardschema.dev), such as zod or valibot.
 */
export class ${className} extends Form<StandardSchemaV1<unknown, ${className}Output>, string> {
	/** The Standard Schema used by this form. */
	protected schema(): StandardSchemaV1<unknown, ${className}Output> {
		// TODO: return the actual schema
		throw new Error("TODO: implement schema()");
	}

	/** Field declarations. Object key order determines the display order in the default view. */
	protected fields(): Record<string, FieldDef> {
		return {
			// TODO: define fields (e.g. name: { label: "Name" })
		};
	}
}
`;

/** Builds the job template content. Extends `Job<TPayload>` and implements `perform()`. */
const jobTemplate = (
	className: string,
	base: string,
): string => `import { Job } from "@tknf/oven/jobs";

/** TODO: Define the payload type for ${className}. */
export type ${className}Payload = {
	// TODO: define fields
};

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends Job<${className}Payload> {
	readonly name = "${snakeCase(base)}";

	async perform(payload: ${className}Payload): Promise<void> {
		// TODO: implement
	}
}
`;

/** Builds the policy template content. Extends `Policy` and declares abilities (arrow function fields returning a boolean). */
const policyTemplate = (className: string): string => `import { Policy } from "@tknf/oven/auth";

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends Policy {
	// TODO: declare abilities, e.g.:
	// readonly canUpdate = (user: Account, resource: Resource): boolean => user.id === resource.ownerId;
}
`;

/** Builds the view template content. Extends `View` and overrides `html()`. */
const viewTemplate = (className: string): string => `import type { Context } from "hono";
import { View } from "@tknf/oven/view";

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends View {
	/** Builds the HTML representation. */
	html(c: Context) {
		// TODO: implement
		return c.text("TODO");
	}
}
`;

/**
 * Builds the seed template content. Since oven itself has no seed execution runtime, it only
 * exports a function and leaves execution to the app.
 */
const seedTemplate = (base: string): string => `/**
 * TODO: Describe run${base}Seed.
 *
 * Execution is the app's responsibility (oven has no seed execution runtime). For example,
 * add a script to package.json's scripts that runs
 * \`vp exec tsx src/seeds/${snakeCase(base)}_seed.ts\`, or import and call it directly from
 * test setup.
 */
export const run${base}Seed = async (): Promise<void> => {
	// TODO: create a DB client and insert data
	// Example:
	// const client = createClient({ url: process.env.DATABASE_URL });
	// const db = drizzle(client);
	// await db.insert(books).values([...]);
};
`;

/**
 * Builds the destination path and content of a template (no side effects). Throws if `type`
 * is unknown.
 */
export const planGeneration = (options: GenerateOptions): GenerationPlan => {
	const { type, name, dialect = "sqlite" } = options;
	if (!GENERATE_TYPES.includes(type)) {
		throw new Error(`Unknown type: ${type}`);
	}

	const className = classNameFor(type, name);
	const base = stripSuffix(type, className);
	const fileName = `${snakeCase(className)}.ts`;
	const dir = options.dir ?? DEFAULT_DIRS[type];
	const filePath = join(dir, fileName);

	const content = ((): string => {
		switch (type) {
			case "handler":
				return handlerTemplate(className);
			case "model":
				return modelTemplate(className, base, dialect);
			case "form":
				return formTemplate(className);
			case "job":
				return jobTemplate(className, base);
			case "policy":
				return policyTemplate(className);
			case "view":
				return viewTemplate(className);
			case "seed":
				return seedTemplate(base);
		}
	})();

	return { filePath, content };
};
