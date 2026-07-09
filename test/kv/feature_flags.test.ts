/**
 * Verifies `FeatureFlags` (a global boolean feature flag built on top of
 * `KeyValueStore`): enable/disable/remove round-trips, prefix handling,
 * fail-closed behavior, and error propagation from store failures.
 */
import { describe, expect, test } from "vite-plus/test";
import { FeatureFlags } from "../../src/kv/feature_flags.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { KeyValueStore } from "../../src/kv/key_value_store.js";

describe("FeatureFlags", () => {
	test("enabled returns false for an unset flag", async () => {
		const flags = new FeatureFlags(new InMemoryKeyValueStore());

		await expect(flags.enabled("beta")).resolves.toBe(false);
	});

	test("enabled returns true after enable", async () => {
		const flags = new FeatureFlags(new InMemoryKeyValueStore());

		await flags.enable("beta");

		await expect(flags.enabled("beta")).resolves.toBe(true);
	});

	test("enabled returns false after disable", async () => {
		const flags = new FeatureFlags(new InMemoryKeyValueStore());

		await flags.enable("beta");
		await flags.disable("beta");

		await expect(flags.enabled("beta")).resolves.toBe(false);
	});

	test("enabled returns false after remove (reverts to unset)", async () => {
		const store = new InMemoryKeyValueStore();
		const flags = new FeatureFlags(store);

		await flags.enable("beta");
		await flags.remove("beta");

		await expect(flags.enabled("beta")).resolves.toBe(false);
		await expect(store.get("flag:beta")).resolves.toBeNull();
	});

	test("the prefix option is reflected in the KV key", async () => {
		const store = new InMemoryKeyValueStore();
		const flags = new FeatureFlags(store, { prefix: "custom:" });

		await flags.enable("beta");

		await expect(store.get("custom:beta")).resolves.toBe("1");
		await expect(store.get("flag:beta")).resolves.toBeNull();
	});

	test('a value other than "1" is treated as false (fail-closed)', async () => {
		const store = new InMemoryKeyValueStore();
		const flags = new FeatureFlags(store);

		await store.set("flag:beta", "true");

		await expect(flags.enabled("beta")).resolves.toBe(false);
	});

	test("enabled propagates the error when store.get throws", async () => {
		class ThrowingKeyValueStore extends KeyValueStore {
			get = async (): Promise<string | null> => {
				throw new Error("KV failure");
			};
			set = async (): Promise<void> => {};
			delete = async (): Promise<void> => {};
		}

		const flags = new FeatureFlags(new ThrowingKeyValueStore());

		await expect(flags.enabled("beta")).rejects.toThrow("KV failure");
	});
});
