/**
 * Abstract base for a job (a unit of work to be run later). This adapter pattern keeps
 * the job definition (this class), the registry (`job_registry.ts`), and the enqueue
 * side (`job_queue.ts`) separate.
 *
 * `TPayload` is serialized for queue transport at enqueue time and reconstructed on the
 * consumer side, so it must always be a JSON-serializable value (one that round-trips
 * through `JSON.stringify` → `JSON.parse` and stays equivalent to the original — no
 * functions, `Date`, `Map`, `Set`, circular references, etc.). This constraint is not
 * enforced by the type system: bringing runtime validation (e.g. Standard Schema) into
 * job definitions would be overkill for a framework that, at this "spec-first" stage,
 * has no real feature driving it yet.
 */
export abstract class Job<TPayload> {
	/**
	 * The job's unique name. Used both as the registration key in `JobRegistry` and as
	 * the identifier for which job a `JobMessage` refers to (see `cloudflare_job_queue.ts`).
	 */
	abstract readonly name: string;

	/** Processes `payload`. Throw on failure (the consumer-side dispatcher routes it to retry). */
	abstract perform(payload: TPayload): Promise<void>;
}
