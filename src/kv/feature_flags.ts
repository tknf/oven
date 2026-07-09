/**
 * Minimal feature flag component built on an injected `KeyValueStore`
 * (a store for global boolean flags). It does not support
 * per-actor targeting or percentage rollouts. If needed, express that in the
 * key name at the application layer (e.g. treat `beta:user-123` as a
 * per-user flag toggled via `enable`/`disable`).
 *
 * Stored values are the strings `"1"` (enabled) / `"0"` (disabled). Note
 * that `disable` writes `"0"` rather than deleting the key, so that
 * "explicitly disabled" can be distinguished from "never configured". Use
 * `remove` to reset a flag back to the unconfigured state.
 *
 * Because `KeyValueStore` is built on an eventual-consistency contract (see
 * `key_value_store.ts`), there may be a delay before an `enable`/`disable`
 * is visible to `enabled` calls from other requests. This is not suitable
 * for use cases that need tightly synchronized flag toggling.
 *
 * `enabled` is fail-closed (any value other than `"1"` — unset, `"0"`, or an
 * unexpected string — is treated as disabled). If `store.get` throws due to
 * a KV store outage, the error is propagated to the caller as-is (collapsing
 * it into "disabled" would make it indistinguishable from a normal,
 * intentional flag-off state).
 */
import type { KeyValueStore } from "./key_value_store.js";

export type FeatureFlagsOptions = {
	/** Key prefix passed to the store. Defaults to `"flag:"`. */
	prefix?: string;
};

/** Bundles operations for global boolean feature flags backed by a `KeyValueStore`. */
export class FeatureFlags {
	private readonly store: KeyValueStore;
	private readonly prefix: string;

	constructor(store: KeyValueStore, options?: FeatureFlagsOptions) {
		this.store = store;
		this.prefix = options?.prefix ?? "flag:";
	}

	private key = (name: string): string => `${this.prefix}${name}`;

	/**
	 * Returns whether the `name` flag is enabled. `true` only if the stored
	 * value is `"1"`; unset, `"0"`, and any other value are all `false`
	 * (fail-closed).
	 */
	enabled = async (name: string): Promise<boolean> => {
		const value = await this.store.get(this.key(name));
		return value === "1";
	};

	/** Enables the `name` flag. */
	enable = async (name: string): Promise<void> => {
		await this.store.set(this.key(name), "1");
	};

	/**
	 * Disables the `name` flag. Writes `"0"` instead of deleting the key
	 * (to distinguish it from "unset").
	 */
	disable = async (name: string): Promise<void> => {
		await this.store.set(this.key(name), "0");
	};

	/** Removes the `name` flag's configuration entirely, resetting it to "unset". */
	remove = async (name: string): Promise<void> => {
		await this.store.delete(this.key(name));
	};
}
