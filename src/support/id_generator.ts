import { createSnowflake } from "@tknf/snowflake";
import type { SnowflakeConfig } from "@tknf/snowflake";

/**
 * Abstraction for ID generation. The model layer generates IDs only through
 * this abstraction and never imports a concrete scheme (Snowflake, UUID,
 * ULID, etc.) directly.
 */
export abstract class IdGenerator {
	/** Generates a single new ID string. */
	abstract generate(): string;
}

/**
 * Default `IdGenerator` implementation, backed by `@tknf/snowflake`. It
 * imports `createSnowflake` from `@tknf/snowflake`'s top-level entry point
 * (not the `/node` or `/browser` subpaths, which depend on Node's
 * `process.env` and the browser's `localStorage` respectively and won't work
 * in serverless environments such as Cloudflare Workers).
 *
 * Defaults to `mode: "edge"`. Reason: in serverless environments such as
 * Workers, a new isolate spins up on every execution, so a `workerId` cannot
 * be assigned stably. Edge mode instead guarantees uniqueness via 22 bits of
 * entropy from `crypto.getRandomValues`, which the package officially
 * recommends for serverless environments such as Workers. This default can
 * be overridden by passing a `SnowflakeConfig`
 * (epoch/datacenterId/workerId/mode/monotonic) to the constructor.
 * Explicitly passing `mode: "default"` switches to deterministic uniqueness
 * based on `(datacenterId, workerId)` and a sequence number. Passing
 * `monotonic: true` (edge-mode-only, since v1.2.0) makes IDs generated
 * within the same millisecond monotonically increase within the same
 * generator, guaranteeing generation-order sorting.
 *
 * Note (on collisions): edge mode provides probabilistic uniqueness (about a
 * 0.12% collision probability at 100 generations per millisecond, per the
 * package README), so consumers are expected to have a UNIQUE constraint
 * plus retry-on-collision. For low-frequency use cases, simply making the ID
 * column a PRIMARY KEY (equivalent to UNIQUE) is enough — any rare collision
 * will surface only as an INSERT failure, and a retry implementation can be
 * skipped. For high-frequency or rights-sensitive use cases (e.g., issuing
 * large volumes of serial codes), whether a retry is needed should be
 * evaluated on a case-by-case basis.
 */
export class SnowflakeIdGenerator extends IdGenerator {
	/**
	 * The generation function. Rather than calling `generateSnowflakeId`
	 * every time, this creates the generation function once via
	 * `createSnowflake` and keeps it. Under `mode: "default"`, the sequence
	 * (the counter within the same millisecond) is held inside this
	 * function's closure, so recreating it on every call would always reset
	 * the sequence to 0 and break monotonicity.
	 */
	private readonly generateId: () => string;

	constructor(config: SnowflakeConfig = {}) {
		super();
		this.generateId = createSnowflake({ mode: "edge", ...config });
	}

	/** Returns a numeric string that fits within a signed 63-bit integer. */
	generate(): string {
		return this.generateId();
	}
}

/**
 * `IdGenerator` implementation that uses Web Crypto's `crypto.randomUUID()`
 * directly, with no external package dependency. It is fully random, so it
 * cannot be sorted chronologically. Prefer `UuidV7IdGenerator`,
 * `UlidIdGenerator`, or `SnowflakeIdGenerator` for primary keys that benefit
 * from insertion-order locality (e.g., to reduce index fragmentation).
 */
export class UuidV4IdGenerator extends IdGenerator {
	/** Returns a string in UUIDv4 format (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`). */
	generate(): string {
		return crypto.randomUUID();
	}
}

/** Converts the generated `Uint8Array` into a zero-padded lowercase hex string. */
const toHex = (bytes: Uint8Array): string =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * `IdGenerator` that implements UUIDv7 (per RFC 9562) from scratch, with no
 * external package dependency, using only `crypto.getRandomValues`. It
 * embeds a millisecond-precision Unix timestamp in the leading 48 bits, so
 * it can be sorted chronologically even via plain string comparison (the
 * ordering of multiple IDs generated within the same millisecond depends on
 * the random portion and is not guaranteed).
 *
 * Layout (128 bits = 16 bytes): leading 48 bits = Unix epoch milliseconds,
 * followed by 4 bits of version (fixed to `0111`), 12 bits of randomness
 * (rand_a), 2 bits of variant (fixed to `10`), and the remaining 62 bits of
 * randomness (rand_b). The implementation first fills 16 bytes with random
 * values, overwrites the leading 6 bytes with the timestamp, sets the
 * version/variant bits, then formats the result as a hex string grouped
 * 8-4-4-4-12.
 */
export class UuidV7IdGenerator extends IdGenerator {
	generate(): string {
		const bytes = crypto.getRandomValues(new Uint8Array(16));
		const timestamp = BigInt(Date.now());

		bytes[0] = Number((timestamp >> 40n) & 0xffn);
		bytes[1] = Number((timestamp >> 32n) & 0xffn);
		bytes[2] = Number((timestamp >> 24n) & 0xffn);
		bytes[3] = Number((timestamp >> 16n) & 0xffn);
		bytes[4] = Number((timestamp >> 8n) & 0xffn);
		bytes[5] = Number(timestamp & 0xffn);

		// Version 7 (fix the upper 4 bits to `0111`)
		bytes[6] = (bytes[6] & 0x0f) | 0x70;
		// Variant (fix the upper 2 bits to `10`)
		bytes[8] = (bytes[8] & 0x3f) | 0x80;

		const hex = toHex(bytes);
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
}

/** Crockford Base32 alphabet (excludes `I`/`L`/`O`/`U` to avoid ambiguity). */
const CROCKFORD_BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Converts a `Uint8Array` to a big-endian `bigint`. */
const bytesToBigInt = (bytes: Uint8Array): bigint =>
	bytes.reduce((accumulator, byte) => (accumulator << 8n) | BigInt(byte), 0n);

/** Encodes the low `length * 5` bits of `value` as `length` Crockford Base32 characters. */
const encodeCrockfordBase32 = (value: bigint, length: number): string => {
	let result = "";
	for (let index = length - 1; index >= 0; index--) {
		const shift = BigInt(index * 5);
		const charIndex = Number((value >> shift) & 0x1fn);
		result += CROCKFORD_BASE32_ALPHABET[charIndex];
	}
	return result;
};

/**
 * `IdGenerator` that implements ULID (https://github.com/ulid/spec) from
 * scratch, with no external package dependency, using only
 * `crypto.getRandomValues`. It embeds a Unix epoch millisecond timestamp in
 * the leading 48 bits, so it can be sorted chronologically even via plain
 * string comparison. The monotonicity extension defined by the spec
 * (increasing monotonically over the previous value within the same
 * millisecond) is not implemented, so the ordering of multiple IDs generated
 * within the same millisecond depends on the random portion and is not
 * guaranteed.
 *
 * Layout (128 bits): a 48-bit timestamp plus 80 bits of randomness, encoded
 * in Crockford Base32 as 10 characters of timestamp followed by 16
 * characters of randomness, for 26 characters total.
 */
export class UlidIdGenerator extends IdGenerator {
	generate(): string {
		const timestamp = BigInt(Date.now());
		const randomValue = bytesToBigInt(crypto.getRandomValues(new Uint8Array(10)));

		return encodeCrockfordBase32(timestamp, 10) + encodeCrockfordBase32(randomValue, 16);
	}
}
