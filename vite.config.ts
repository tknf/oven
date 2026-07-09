import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, defineProject } from "vite-plus";

/**
 * Exclude these paths from the code formatter/linter: user-facing docs (`docs/`),
 * agent definitions (`.agents/`, `.claude/`), and the generated lock file.
 */
const ciIgnorePatterns = ["docs/**", ".agents/**", ".claude/**", "skills-lock.json"];

export default defineConfig({
	staged: {
		"*": "vp check --fix",
	},
	fmt: {
		ignorePatterns: ciIgnorePatterns,
		// Oxfmt's defaults closely match Biome's, but printWidth/useTabs differ, so set them explicitly
		printWidth: 100,
		useTabs: true,
	},
	lint: {
		ignorePatterns: ciIgnorePatterns,
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		rules: { "vite-plus/prefer-vite-plus-imports": "error" },
		options: { typeAware: true, typeCheck: true },
	},
	/**
	 * Library build configuration via `vp pack`. To support per-folder subpath
	 * imports, the root and each module folder's index.ts are specified as
	 * entries via glob.
	 */
	pack: {
		entry: ["src/index.ts", "src/*/index.ts"],
		dts: true,
		fixedExtension: false,
		unbundle: true,
	},
	/**
	 * Node / workerd two-project test setup.
	 */
	test: {
		projects: [
			// L1/L2: pure logic and model/adapter tests involving a DB (in-memory libsql)
			defineProject({
				test: {
					name: "node",
					include: ["test/**/*.test.ts"],
					exclude: ["test/workers/**"],
				},
			}),
			// L3: Workers integration tests for code using KV/R2 bindings (under test/workers/, mirroring src)
			defineProject({
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.jsonc" },
					}),
				],
				test: {
					name: "workerd",
					include: ["test/workers/**/*.test.ts"],
				},
			}),
		],
	},
});
