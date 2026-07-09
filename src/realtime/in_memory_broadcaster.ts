/**
 * A `Broadcaster` implementation intended for development, testing, and
 * single-process deployments. It simply keeps per-channel listeners in a
 * `Map<string, Set<listener>>` in process memory, without persistence or
 * cross-process delivery. If you want delivery to reach every instance in a
 * multi-instance environment, switch to an adapter such as Redis Pub/Sub
 * (expected to be provided as a subpath).
 *
 * When wiring this into the context with `ScopedValueAccessor`
 * (`routing/context_accessor.ts`), be sure to specify `scope: "app"`. With the
 * default `"request"`, a separate instance would be created per request and
 * `publish` would no longer reach subscribers within the same process.
 */
import { Broadcaster } from "./broadcaster.js";
import type { BroadcastMessage } from "./broadcaster.js";

type Listener = (message: BroadcastMessage) => void;

export class InMemoryBroadcaster extends Broadcaster {
	private readonly channels = new Map<string, Set<Listener>>();

	constructor(
		private readonly options?: { onListenerError?: (error: unknown, channel: string) => void },
	) {
		super();
	}

	/**
	 * Synchronously calls every listener of `channel`. Exceptions thrown inside a
	 * listener are swallowed and passed to `options.onListenerError` (a no-op by
	 * default), so that one listener's failure does not break the others or the
	 * `publish` caller.
	 */
	async publish(channel: string, message: BroadcastMessage): Promise<void> {
		const listeners = this.channels.get(channel);
		if (!listeners) return;

		for (const listener of listeners) {
			try {
				listener(message);
			} catch (error) {
				this.options?.onListenerError?.(error, channel);
			}
		}
	}

	subscribe(channel: string, listener: Listener): () => void {
		let listeners = this.channels.get(channel);
		if (!listeners) {
			listeners = new Set();
			this.channels.set(channel, listeners);
		}
		listeners.add(listener);

		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.channels.delete(channel);
			}
		};
	}
}
