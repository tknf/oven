/**
 * `main` entry point for the workerd test project's `wrangler.jsonc`. A Durable
 * Object class must be exported from the worker named by `main` for its
 * `class_name` binding to resolve, so this file exists solely to re-export
 * `BroadcasterDurableObject`. `test/workers/**` tests only reach bindings
 * through `env` (`cloudflare:workers`) and never call a default `fetch`
 * export, so — mirroring `src/index.ts` (the previous `main`, which also has
 * no default export) — none is defined here.
 */
export { BroadcasterDurableObject } from "../../src/cloudflare/broadcaster_durable_object.js";
