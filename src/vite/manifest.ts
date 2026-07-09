/**
 * A self-contained structural type and parser for consuming the `manifest.json`
 * produced by Vite.
 *
 * The `vite` package itself is not imported (a design decision for the whole
 * `ViteAssets` module). `ManifestChunk` (a `vite` type) has the shape
 * `{ file: string; src?: string; css?: string[]; imports?: string[]; assets?: string[];
 * isEntry?: boolean; name?: string }`, but here only the fields that `ViteAssets`
 * actually uses are defined as a self-contained type.
 *
 * Following the project rule that the return value of `JSON.parse` must never be
 * passed through untyped (AGENTS.md / TypeScript rules), the parsed value is
 * received as `unknown` and validated structurally with a type guard. A
 * malformed manifest is rejected fail-closed (throwing `ViteManifestParseError`).
 */

/** The shape of a single manifest entry. Only the parts of Vite's `ManifestChunk` needed for resolution. */
export type ViteManifestChunk = {
	/** The output file name (with hash), relative to base. */
	file: string;
	src?: string;
	/** The list of CSS output files imported by this chunk. */
	css?: string[];
	/** The list of manifest keys for other chunks imported by this chunk. */
	imports?: string[];
	isEntry?: boolean;
};

/** The whole manifest (logical name -> chunk info). */
export type ViteManifest = Record<string, ViteManifestChunk>;

/** Error thrown when the manifest JSON does not have the expected shape. */
export class ViteManifestParseError extends Error {
	constructor(message: string) {
		super(`Failed to parse Vite manifest: ${message}`);
		this.name = "ViteManifestParseError";
	}
}

/** Determines whether a value is a plain object (an object excluding arrays and null). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Determines whether a value is a `string[]`. */
const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * A type guard that determines whether a value is a valid `ViteManifestChunk`.
 * `file` must be a required string, `css`/`imports` are optional `string[]`, and
 * `isEntry` is an optional boolean.
 */
const isViteManifestChunk = (value: unknown): value is ViteManifestChunk => {
	if (!isPlainObject(value)) {
		return false;
	}
	if (typeof value.file !== "string") {
		return false;
	}
	if (value.css !== undefined && !isStringArray(value.css)) {
		return false;
	}
	if (value.imports !== undefined && !isStringArray(value.imports)) {
		return false;
	}
	if (value.isEntry !== undefined && typeof value.isEntry !== "boolean") {
		return false;
	}
	return true;
};

/**
 * Converts a Vite `manifest.json` string into a typed `ViteManifest`.
 * Throws `ViteManifestParseError` (fail-closed) if the top level is not an
 * object, or if any entry does not satisfy the `ViteManifestChunk` shape.
 */
export const parseViteManifest = (json: string): ViteManifest => {
	const parsed: unknown = JSON.parse(json);

	if (!isPlainObject(parsed)) {
		throw new ViteManifestParseError("The top level must be an object");
	}

	const manifest: ViteManifest = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!isViteManifestChunk(value)) {
			throw new ViteManifestParseError(
				`Entry "${key}" does not have the expected shape (an object containing file: string)`,
			);
		}
		manifest[key] = value;
	}

	return manifest;
};
