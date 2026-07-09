/**
 * Verifies the `IdGenerator` implementations (`SnowflakeIdGenerator`, `UuidV4IdGenerator`,
 * `UuidV7IdGenerator`, `UlidIdGenerator`): the format of generated values, chronological
 * sortability, and absence of duplicates (docs/testing.md L1).
 */
import { parseSnowflakeId } from "@tknf/snowflake";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import {
	SnowflakeIdGenerator,
	UlidIdGenerator,
	UuidV4IdGenerator,
	UuidV7IdGenerator,
} from "../../src/support/id_generator.js";

describe("SnowflakeIdGenerator", () => {
	test("returns a numeric string as before when called with no arguments", () => {
		const generator = new SnowflakeIdGenerator();

		const id = generator.generate();

		expect(id).toMatch(/^\d+$/);
	});

	test("does not produce duplicates on repeated generation", () => {
		const generator = new SnowflakeIdGenerator();

		const ids = Array.from({ length: 100 }, () => generator.generate());

		expect(new Set(ids).size).toBe(ids.length);
	});

	test("can be recovered when mode is default with datacenterId/workerId", () => {
		const generator = new SnowflakeIdGenerator({ mode: "default", datacenterId: 1, workerId: 2 });

		const id = generator.generate();
		const parsed = parseSnowflakeId(id, undefined, "default");

		expect(parsed.datacenterId).toBe(1);
		expect(parsed.workerId).toBe(2);
	});

	test("a custom epoch is reflected in the recovered timestamp", () => {
		const epoch = Date.UTC(2024, 0, 1);
		const generator = new SnowflakeIdGenerator({ epoch });
		const before = Date.now();

		const id = generator.generate();
		const parsed = parseSnowflakeId(id, epoch);

		const after = Date.now();
		expect(parsed.timestamp).toBeGreaterThanOrEqual(before);
		expect(parsed.timestamp).toBeLessThanOrEqual(after);
	});
});

describe("UuidV4IdGenerator", () => {
	test("returns a UUIDv4-formatted (version 4) string", () => {
		const generator = new UuidV4IdGenerator();

		const id = generator.generate();

		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test("does not produce duplicates on repeated generation", () => {
		const generator = new UuidV4IdGenerator();

		const ids = Array.from({ length: 100 }, () => generator.generate());

		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("UuidV7IdGenerator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("returns a UUIDv7-formatted (version 7, variant 10xx) string", () => {
		const generator = new UuidV7IdGenerator();

		const id = generator.generate();

		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	test("the leading 48 bits match the fixed time's millisecond timestamp", () => {
		const fixedTime = Date.UTC(2024, 5, 15, 12, 0, 0);
		vi.setSystemTime(fixedTime);
		const generator = new UuidV7IdGenerator();

		const id = generator.generate();

		const timestampHex = id.slice(0, 8) + id.slice(9, 13);
		expect(BigInt(`0x${timestampHex}`)).toBe(BigInt(fixedTime));
	});

	test("generating after advancing the clock sorts ascending by string comparison", () => {
		const generator = new UuidV7IdGenerator();
		vi.setSystemTime(Date.UTC(2024, 5, 15, 12, 0, 0));

		const earlier = generator.generate();

		vi.setSystemTime(Date.UTC(2024, 5, 15, 12, 0, 1));
		const later = generator.generate();

		expect(earlier < later).toBe(true);
	});

	test("does not produce duplicates on repeated generation", () => {
		const generator = new UuidV7IdGenerator();

		const ids = Array.from({ length: 100 }, () => generator.generate());

		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("UlidIdGenerator", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test("returns a 26-character Crockford Base32 string", () => {
		const generator = new UlidIdGenerator();

		const id = generator.generate();

		expect(id).toHaveLength(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
	});

	test("the leading 10 characters match the fixed time's timestamp", () => {
		const fixedTime = Date.UTC(2024, 5, 15, 12, 0, 0);
		vi.setSystemTime(fixedTime);
		const generator = new UlidIdGenerator();
		const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

		const id = generator.generate();

		const decoded = id
			.slice(0, 10)
			.split("")
			.reduce((accumulator, char) => accumulator * 32 + alphabet.indexOf(char), 0);
		expect(decoded).toBe(fixedTime);
	});

	test("generating after advancing the clock sorts ascending by string comparison", () => {
		const generator = new UlidIdGenerator();
		vi.setSystemTime(Date.UTC(2024, 5, 15, 12, 0, 0));

		const earlier = generator.generate();

		vi.setSystemTime(Date.UTC(2024, 5, 15, 12, 0, 1));
		const later = generator.generate();

		expect(earlier < later).toBe(true);
	});

	test("does not produce duplicates on repeated generation", () => {
		const generator = new UlidIdGenerator();

		const ids = Array.from({ length: 100 }, () => generator.generate());

		expect(new Set(ids).size).toBe(ids.length);
	});
});
