/**
 * Template generation logic used by `oven generate` (pure functions, no side effects).
 * Actual file writing is handled by `src/cli/index.ts`.
 */
import { join } from "node:path";

/** Kinds of templates accepted by `oven generate`. */
export type GenerateType =
	| "routes"
	| "schema"
	| "model"
	| "form"
	| "policy"
	| "view"
	| "job"
	| "admin";

/** Drizzle dialect targeted by the `schema` and `model` templates. */
export type ModelDialect = "sqlite" | "pg" | "mysql";

/** Input to `planGeneration`. */
export type GenerateOptions = {
	type: GenerateType;
	/** Domain directory name under `src/domains/` (normalized to snake_case). */
	domain: string;
	/**
	 * Entity name for class/table names (defaults to `domain`); required for `view`
	 * and `job`, where it also becomes the file name.
	 */
	name?: string;
	/** Overrides the output directory. */
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
	"routes",
	"schema",
	"model",
	"form",
	"policy",
	"view",
	"job",
	"admin",
];

/** Types whose template depends on the Drizzle dialect. */
const DIALECT_TYPES: readonly GenerateType[] = ["schema", "model"];

/** Types that emit one file per name inside a domain subdirectory. */
const NAMED_FILE_DIRS = {
	view: "views",
	job: "jobs",
} as const satisfies Partial<Record<GenerateType, string>>;

/** Class name suffix per class-producing type. */
const TYPE_SUFFIXES = {
	model: "Model",
	form: "Form",
	policy: "Policy",
	view: "View",
	job: "Job",
	admin: "Resource",
} as const satisfies Partial<Record<GenerateType, string>>;

/** A type that produces a class and therefore has a class name suffix. */
export type ClassGenerateType = keyof typeof TYPE_SUFFIXES;

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
 * ends with the suffix, it is not appended twice (e.g. `BookModel` stays `BookModel`).
 */
export const classNameFor = (type: ClassGenerateType, name: string): string => {
	const base = pascalCase(name);
	const suffix = TYPE_SUFFIXES[type];
	return base.endsWith(suffix) ? base : `${base}${suffix}`;
};

/** Strips the suffix from `className` to get the base name (used for table variable names, job names, etc.). */
const stripSuffix = (type: ClassGenerateType, className: string): string => {
	const suffix = TYPE_SUFFIXES[type];
	return className.endsWith(suffix) ? className.slice(0, -suffix.length) : className;
};

/** Lowercases only the first character of PascalCase `word` (camelCase conversion). */
const toCamelCase = (word: string): string =>
	word.length === 0 ? word : word.charAt(0).toLowerCase() + word.slice(1);

/**
 * Builds the routes template content: a Hono sub-app built as a method chain, so the
 * route types it declares reach `hc` and `testClient` once the app mounts it.
 */
const routesTemplate = (variable: string, domain: string): string => `import { Hono } from "hono";

/**
 * TODO: Describe the ${domain} routes.
 * Mount it from src/main.ts with \`app.route("/${domain}", ${variable})\`. Keep adding
 * routes to this method chain so their types stay part of the app's schema.
 */
export const ${variable} = new Hono().get("/", (c) => {
	// TODO: implement
	return c.text("TODO");
});
`;

/** Builds the schema template content: only the Drizzle table definition for the dialect. */
const schemaTemplate = (base: string, dialect: ModelDialect): string => {
	const tableVar = toCamelCase(base);
	const tableName = snakeCase(base);

	if (dialect === "pg") {
		return `import { bigint, pgTable, text } from "drizzle-orm/pg-core";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = pgTable("${tableName}", {
	id: text("id").primaryKey(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
`;
	}

	if (dialect === "mysql") {
		return `import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = mysqlTable("${tableName}", {
	id: varchar("id", { length: 255 }).primaryKey(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
`;
	}

	return `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** TODO: Adjust the table definition to match the actual columns. */
export const ${tableVar} = sqliteTable("${tableName}", {
	id: text("id").primaryKey(),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});
`;
};

/**
 * Builds the model template content. The table comes from the domain's `schema.ts`
 * (generate it first with the `schema` template); the base class differs per dialect.
 */
const modelTemplate = (className: string, base: string, dialect: ModelDialect): string => {
	const tableVar = toCamelCase(base);

	if (dialect === "pg") {
		return `import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { PgModel } from "@tknf/oven/model";
import { ${tableVar} } from "./schema.js";

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
		return `import type { MySql2PreparedQueryHKT, MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import { MySqlModel } from "@tknf/oven/model";
import { ${tableVar} } from "./schema.js";

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

	return `import { SQLiteModel } from "@tknf/oven/model";
import { ${tableVar} } from "./schema.js";

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

/** Builds the view template content (a `.tsx` file). Extends `View` and overrides `html()`. */
const viewTemplate = (className: string): string => `import type { Context } from "hono";
import { View } from "@tknf/oven/view";

/**
 * TODO: Describe ${className}.
 */
export class ${className} extends View {
	/** Builds the HTML representation. */
	html(c: Context) {
		// TODO: implement
		return c.html(<p>TODO</p>);
	}
}
`;

/**
 * Builds the admin template content. Extends `AdminResource` and takes the
 * corresponding Model and Drizzle table via constructor injection (the same pattern used
 * throughout `docs/admin.md` and the admin test fixtures), so the generated class type-checks
 * on its own without depending on a real model/table existing at a guessed import path. Since
 * `AdminResource#model` is typed as the structural `AdminModel` (identical across the
 * SQLite/Postgres/MySQL `Model` subclasses), the template has no dialect-specific branch.
 */
const adminResourceTemplate = (className: string, base: string): string => {
	const tableVar = toCamelCase(base);
	const modelVar = `${tableVar}Model`;

	return `import type { Table } from "drizzle-orm";
import type { AdminModel } from "@tknf/oven/admin";
import { AdminResource } from "@tknf/oven/admin";

// TODO: import the corresponding table and build the Model instance where the app wires it, e.g.:
// import { ${tableVar} } from "./schema.js";
// import { ${base}Model } from "./model.js";

/**
 * TODO: Describe ${className}.
 * Register it by adding an instance to \`AdminPanel\`'s \`resources\` option, e.g.
 * \`resources: [new ${className}(${modelVar}, ${tableVar})]\` (see docs/admin.md).
 */
export class ${className} extends AdminResource {
	constructor(
		private readonly ${modelVar}: AdminModel,
		private readonly ${tableVar}: Table,
	) {
		super();
	}

	get key(): string {
		// TODO: URL slug shown in admin routes
		return "${snakeCase(base)}";
	}

	get label(): string {
		// TODO: resource name shown in nav and headings
		return "${base}";
	}

	get model(): AdminModel {
		return this.${modelVar};
	}

	get table(): Table {
		return this.${tableVar};
	}

	get primaryKey(): string {
		// TODO: adjust if the primary key column is not "id"
		return "id";
	}

	// TODO: implement form() to make this resource writable, e.g.:
	// form() {
	//   return new ${base}Form();
	// }
}
`;
};

/** Returns the class name for a class-producing type, prefixing a view with its domain. */
const classNameForPlan = (type: ClassGenerateType, domain: string, entity: string): string =>
	type === "view" ? classNameFor(type, `${domain}_${entity}`) : classNameFor(type, entity);

/**
 * Builds the destination path and content of a template (no side effects). Throws if `type`
 * is unknown, if `dialect` is given for a type that does not use it, or if `name` is missing
 * for `view`/`job`.
 */
export const planGeneration = (options: GenerateOptions): GenerationPlan => {
	const { type, dialect } = options;
	if (!GENERATE_TYPES.includes(type)) {
		throw new Error(`Unknown type: ${type}`);
	}
	if (dialect !== undefined && !DIALECT_TYPES.includes(type)) {
		throw new Error(`--dialect only applies to the schema and model templates, not "${type}"`);
	}
	if ((type === "view" || type === "job") && options.name === undefined) {
		throw new Error(`The ${type} template requires a name (e.g. oven generate ${type} books list)`);
	}

	const domain = snakeCase(options.domain);
	const entity = options.name ?? options.domain;
	const domainDir = `src/domains/${domain}`;

	const target = ((): { dir: string; fileName: string; content: string } => {
		switch (type) {
			case "routes":
				return {
					dir: domainDir,
					fileName: "routes.ts",
					content: routesTemplate(`${toCamelCase(pascalCase(entity))}Routes`, domain),
				};
			case "schema":
				return {
					dir: domainDir,
					fileName: "schema.ts",
					content: schemaTemplate(pascalCase(entity), dialect ?? "sqlite"),
				};
			case "model": {
				const className = classNameFor(type, entity);
				const base = stripSuffix(type, className);
				return {
					dir: domainDir,
					fileName: "model.ts",
					content: modelTemplate(className, base, dialect ?? "sqlite"),
				};
			}
			case "form":
				return {
					dir: domainDir,
					fileName: "form.ts",
					content: formTemplate(classNameFor(type, entity)),
				};
			case "policy":
				return {
					dir: domainDir,
					fileName: "policy.ts",
					content: policyTemplate(classNameFor(type, entity)),
				};
			case "view":
				return {
					dir: join(domainDir, NAMED_FILE_DIRS.view),
					fileName: `${snakeCase(entity)}.tsx`,
					content: viewTemplate(classNameForPlan(type, domain, entity)),
				};
			case "job": {
				const className = classNameFor(type, entity);
				return {
					dir: join(domainDir, NAMED_FILE_DIRS.job),
					fileName: `${snakeCase(stripSuffix(type, className))}.ts`,
					content: jobTemplate(className, stripSuffix(type, className)),
				};
			}
			case "admin": {
				const className = classNameFor(type, entity);
				return {
					dir: domainDir,
					fileName: "admin.ts",
					content: adminResourceTemplate(className, stripSuffix(type, className)),
				};
			}
		}
	})();

	return { filePath: join(options.dir ?? target.dir, target.fileName), content: target.content };
};
