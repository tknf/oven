/**
 * Test implementation of `Broadcaster`. Records every `publish` call into
 * `published` so tests can assert what an action broadcast, and — mirroring
 * `InMemoryBroadcaster`'s semantics — also delivers messages to subscribers
 * synchronously, so code under test that relies on `subscribe` observing its
 * own `publish` calls keeps working against this fake. Exported only from
 * `src/test/index.ts`, not from the core `src/index.ts` (since it's
 * test-only).
 */
import type { BroadcastMessage } from "../realtime/broadcaster.js";
import { Broadcaster } from "../realtime/broadcaster.js";

type Listener = (message: BroadcastMessage) => void;

/** A single publish call recorded by `TestBroadcaster`. */
export type PublishedMessage = {
	channel: string;
	message: BroadcastMessage;
};

export class TestBroadcaster extends Broadcaster {
	/** Recorded publish calls, in call order. */
	readonly published: PublishedMessage[] = [];

	private readonly channels = new Map<string, Set<Listener>>();

	async publish(channel: string, message: BroadcastMessage): Promise<void> {
		this.published.push({ channel, message });

		const listeners = this.channels.get(channel);
		if (!listeners) return;

		for (const listener of listeners) {
			try {
				listener(message);
			} catch {
				// Swallow listener errors so one failing subscriber cannot break other
				// listeners or the `publish` caller, per the `Broadcaster` contract.
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

	/** Returns only the messages that were published to `channel`, in call order. */
	publishedTo(channel: string): BroadcastMessage[] {
		return this.published
			.filter((entry) => entry.channel === channel)
			.map((entry) => entry.message);
	}

	/** Clears the accumulated publish records (for cleanup between tests). */
	clear(): void {
		this.published.length = 0;
	}
}
