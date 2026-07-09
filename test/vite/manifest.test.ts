/**
 * Tests for `parseViteManifest`. Confirms malformed JSON is rejected fail-closed.
 */
import { describe, expect, test } from "vite-plus/test";
import { parseViteManifest, ViteManifestParseError } from "../../src/vite/manifest.js";

describe("parseViteManifest", () => {
	test("returns valid manifest JSON, typed", () => {
		const manifest = parseViteManifest(
			JSON.stringify({
				"src/client.ts": {
					file: "assets/client-abc123.js",
					css: ["assets/client-def456.css"],
					imports: ["_shared-ghi789.js"],
					isEntry: true,
				},
				"_shared-ghi789.js": {
					file: "assets/shared-ghi789.js",
				},
			}),
		);

		expect(manifest["src/client.ts"]?.file).toBe("assets/client-abc123.js");
		expect(manifest["src/client.ts"]?.css).toEqual(["assets/client-def456.css"]);
		expect(manifest["_shared-ghi789.js"]?.file).toBe("assets/shared-ghi789.js");
	});

	test("throws ViteManifestParseError when the top level is an array", () => {
		expect(() => parseViteManifest(JSON.stringify([1, 2, 3]))).toThrow(ViteManifestParseError);
	});

	test("throws ViteManifestParseError when the top level is not an object", () => {
		expect(() => parseViteManifest(JSON.stringify("not-an-object"))).toThrow(
			ViteManifestParseError,
		);
	});

	test("throws ViteManifestParseError when an entry is missing file", () => {
		expect(() =>
			parseViteManifest(
				JSON.stringify({
					"src/client.ts": { css: ["a.css"] },
				}),
			),
		).toThrow(ViteManifestParseError);
	});

	test("throws ViteManifestParseError when an entry is not an object", () => {
		expect(() =>
			parseViteManifest(
				JSON.stringify({
					"src/client.ts": "not-an-object",
				}),
			),
		).toThrow(ViteManifestParseError);
	});
});
