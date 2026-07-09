import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Pure functions that validate `c.env` (the set of Cloudflare Workers
 * bindings/secrets, or environment variables in adapters such as Node) using
 * Standard Schema.
 *
 * Lazily checking only the part of `c.env` used at the moment it's needed
 * means missing object storage or OAuth credentials only surface when
 * they're actually used. This layer lets an app declare the environment
 * values it needs as a single Standard Schema up front, and validate them
 * all at once at startup (on the first request) to fail fast.
 *
 * There is no dedicated middleware for wiring up "validate once at startup
 * and hand out the result"; the canonical pattern is to pass `validateEnv`
 * to `ScopedValueAccessor` (`scope: "app"`) in
 * `src/routing/context_accessor.ts` (since the `Promise` returned by
 * `create` is itself memoized, even a failed validation fails fast with the
 * same error on every call):
 *
 * ```ts
 * // App-side wiring module. The canonical pattern is to distribute a validated, typed env.
 * type AppBindings = { TURSO_DATABASE_URL: string };
 * type AppEnv = { Bindings: AppBindings; Variables: { config?: AppConfig } };
 * const accessor = new ScopedValueAccessor<AppEnv, "config">("config", {
 *   create: (c) => validateEnv(configSchema, c.env),
 *   scope: "app", // Validated once on the first request (failure is memoized and fails fast every time)
 * });
 * export const registerConfig = accessor.register;
 * export const useConfig = accessor.use;
 * ```
 */
export class EnvValidationError extends Error {
	readonly issues: ReadonlyArray<StandardSchemaV1.Issue>;

	constructor(issues: ReadonlyArray<StandardSchemaV1.Issue>) {
		super(formatIssues(issues));
		this.name = "EnvValidationError";
		this.issues = issues;
	}
}

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string => {
	const lines = issues.map((issue) => `- ${formatPath(issue.path)}: ${issue.message}`);
	return `Failed to validate environment values (c.env):\n${lines.join("\n")}`;
};

const formatPath = (path: StandardSchemaV1.Issue["path"]): string => {
	if (!path || path.length === 0) return "(root)";
	return path
		.map((segment) => String(typeof segment === "object" ? segment.key : segment))
		.join(".");
};

/**
 * Validates `value` against `schema`. Standard Schema's `validate` may
 * return either synchronously or asynchronously
 * (`Result<Output> | Promise<Result<Output>>`), so this awaits either form.
 * Throws `EnvValidationError` on validation failure; otherwise returns the
 * validated (schema-transformed) value.
 */
export const validateEnv = async <S extends StandardSchemaV1>(
	schema: S,
	value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> => {
	const rawResult = schema["~standard"].validate(value);
	const result = rawResult instanceof Promise ? await rawResult : rawResult;

	if (result.issues) throw new EnvValidationError(result.issues);

	return result.value;
};
