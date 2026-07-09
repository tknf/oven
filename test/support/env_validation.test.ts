/**
 * Verifies `validateEnv`/`EnvValidationError`, which validate `c.env` against a Standard Schema
 * (docs/testing.md L1). Rather than an external schema library, this reproduces Standard Schema
 * with a minimal in-house stub that follows the standardschema.dev spec. Wiring involving
 * memoization is covered by `ScopedValueAccessor`'s existing tests and is out of scope here.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test } from "vite-plus/test";
import { EnvValidationError, validateEnv } from "../../src/support/env_validation.js";

/** Minimal Standard Schema implementation for tests. `validate` accepts either sync or async. */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate,
	},
});

describe("validateEnv", () => {
	test("returns the validated value when validation succeeds", async () => {
		const schema = defineStubSchema<{ name: string }>((value) => ({
			value: value as { name: string },
		}));

		await expect(validateEnv(schema, { name: "example-app" })).resolves.toEqual({
			name: "example-app",
		});
	});

	test("supports async validate as well", async () => {
		const schema = defineStubSchema<{ ok: true }>(async (_value) => ({ value: { ok: true } }));

		await expect(validateEnv(schema, {})).resolves.toEqual({ ok: true });
	});

	test("throws EnvValidationError when validation fails", async () => {
		const schema = defineStubSchema((_value) => ({
			issues: [{ message: "is required", path: ["TURSO_DATABASE_URL"] }],
		}));

		await expect(validateEnv(schema, {})).rejects.toBeInstanceOf(EnvValidationError);
	});
});

describe("EnvValidationError", () => {
	test("keeps issues as-is", async () => {
		const issues: StandardSchemaV1.Issue[] = [
			{ message: "is required", path: ["TURSO_DATABASE_URL"] },
			{ message: "invalid format", path: ["R2_BUCKET"] },
		];
		const schema = defineStubSchema((_value) => ({ issues }));

		try {
			await validateEnv(schema, {});
			throw new Error("should not be reached");
		} catch (error) {
			if (!(error instanceof EnvValidationError)) throw error;
			expect(error.issues).toEqual(issues);
		}
	});

	test("formats the message to include every issue's path and message", async () => {
		const schema = defineStubSchema((_value) => ({
			issues: [
				{ message: "is required", path: ["TURSO_DATABASE_URL"] },
				{ message: "invalid format", path: ["R2_BUCKET"] },
			],
		}));

		try {
			await validateEnv(schema, {});
			throw new Error("should not be reached");
		} catch (error) {
			if (!(error instanceof EnvValidationError)) throw error;
			expect(error.message).toContain("Failed to validate environment values (c.env)");
			expect(error.message).toContain("TURSO_DATABASE_URL");
			expect(error.message).toContain("is required");
			expect(error.message).toContain("R2_BUCKET");
			expect(error.message).toContain("invalid format");
		}
	});

	test("an issue with no path is formatted as (root)", async () => {
		const schema = defineStubSchema((_value) => ({
			issues: [{ message: "invalid value" }],
		}));

		try {
			await validateEnv(schema, {});
			throw new Error("should not be reached");
		} catch (error) {
			if (!(error instanceof EnvValidationError)) throw error;
			expect(error.message).toContain("(root)");
			expect(error.message).toContain("invalid value");
		}
	});
});
