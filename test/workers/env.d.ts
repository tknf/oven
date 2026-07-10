/**
 * `Cloudflare.Env` extension for `test/workers/**` (the workerd project).
 * Declares types corresponding to the binding definitions (KV, TEST_BUCKET, BROADCASTER) in
 * `wrangler.jsonc`. Bindings used by tests are hand-written rather than generated via
 * `wrangler types` (this library is not an app and has no app-side worker.d.ts).
 *
 * `BROADCASTER` is left untyped (plain `DurableObjectNamespace`, no generic) rather than
 * `DurableObjectNamespace<BroadcasterDurableObject>`: the generic's constraint
 * (`Rpc.DurableObjectBranded`) is only satisfied by classes extending `DurableObject` from
 * `cloudflare:workers`, and `BroadcasterDurableObject` deliberately implements the legacy
 * `DurableObject` interface instead (see its doc comment) so it stays importable from Node.
 */
declare namespace Cloudflare {
	interface Env {
		KV: KVNamespace;
		TEST_BUCKET: R2Bucket;
		BROADCASTER: DurableObjectNamespace;
	}
}
