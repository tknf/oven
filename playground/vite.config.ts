import devServer from "@hono/vite-dev-server";
import { defineConfig } from "vite-plus";

/**
 * Dev server for the committed admin-panel playground (`playground/main.ts`).
 * `root` is pinned to this directory so the config also works when Vite is
 * invoked with `-c playground/vite.config.ts` from the repository root.
 */
export default defineConfig({
	root: import.meta.dirname,
	plugins: [devServer({ entry: "./main.ts" })],
});
