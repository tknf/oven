/**
 * `Cloudflare.Env` extension for `test/workers/**` (the workerd project).
 * Declares types corresponding to the binding definitions (KV, TEST_BUCKET) in `wrangler.jsonc`.
 * Bindings used by tests are hand-written rather than generated via `wrangler types`
 * (this library is not an app and has no app-side worker.d.ts).
 */
declare namespace Cloudflare {
	interface Env {
		KV: KVNamespace;
		TEST_BUCKET: R2Bucket;
	}
}
