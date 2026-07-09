/**
 * Tests `ApiToken` (API token authentication). Verifies the selector/validator
 * token issuance, the round trip of verification, behavior when a prefix is
 * specified, tamper detection, unknown selector, malformed format, and that
 * the value differs on every issuance.
 */
import { describe, expect, test } from "vite-plus/test";
import { ApiToken } from "../../src/auth/api_token.js";

type StoredApiToken = {
	validatorHash: string;
	ability: string;
};

describe("ApiToken", () => {
	test("verify succeeds and returns the record when lookup returns validatorHash for an issued token", async () => {
		const apiToken = new ApiToken();
		const issued = await apiToken.issue();
		const stored: StoredApiToken = { validatorHash: issued.validatorHash, ability: "read" };

		const record = await apiToken.verify(issued.token, (selector) =>
			selector === issued.selector ? stored : null,
		);

		expect(record).toEqual(stored);
	});

	test("when prefix is specified the token starts with the prefix, and verify strips the prefix before validating", async () => {
		const apiToken = new ApiToken({ prefix: "oven_" });
		const issued = await apiToken.issue();
		const stored: StoredApiToken = { validatorHash: issued.validatorHash, ability: "read" };

		expect(issued.token.startsWith("oven_")).toBe(true);

		const record = await apiToken.verify(issued.token, (selector) =>
			selector === issued.selector ? stored : null,
		);
		expect(record).toEqual(stored);
	});

	test("verifying a token without the prefix against a prefix-configured ApiToken returns null", async () => {
		const apiToken = new ApiToken({ prefix: "oven_" });
		const issued = await apiToken.issue();
		const stored: StoredApiToken = { validatorHash: issued.validatorHash, ability: "read" };
		const withoutPrefix = issued.token.replace("oven_", "");

		const record = await apiToken.verify(withoutPrefix, (selector) =>
			selector === issued.selector ? stored : null,
		);

		expect(record).toBeNull();
	});

	test("verify returns null when the validator is tampered with", async () => {
		const apiToken = new ApiToken();
		const issued = await apiToken.issue();
		const stored: StoredApiToken = { validatorHash: issued.validatorHash, ability: "read" };
		const [selector, validator] = issued.token.split(".");

		/**
		 * Replaces the first character with one guaranteed to differ from the original.
		 * The last character is subject to base64url bit-boundary rules where low bits
		 * are ignored on decode, so a different last character can still decode to the
		 * same byte sequence (not a real tamper); the first character is unaffected by
		 * that and always has all bits significant.
		 */
		const firstChar = validator.startsWith("A") ? "B" : "A";
		const tamperedToken = `${selector}.${firstChar}${validator.slice(1)}`;

		const record = await apiToken.verify(tamperedToken, (lookedUpSelector) =>
			lookedUpSelector === selector ? stored : null,
		);

		expect(record).toBeNull();
	});

	test("verify returns null when the selector is unknown (lookup returns null)", async () => {
		const apiToken = new ApiToken();
		const issued = await apiToken.issue();

		const record = await apiToken.verify(issued.token, () => null);

		expect(record).toBeNull();
	});

	test("verify returns null for a malformed token", async () => {
		const apiToken = new ApiToken();

		await expect(apiToken.verify("no-separator", () => null)).resolves.toBeNull();
		await expect(apiToken.verify("", () => null)).resolves.toBeNull();
	});

	test("verify returns null instead of throwing when the stored validatorHash is not valid base64url", async () => {
		const apiToken = new ApiToken();
		const issued = await apiToken.issue();
		const stored: StoredApiToken = { validatorHash: "!!!not-base64url!!!", ability: "read" };

		const record = await apiToken.verify(issued.token, (selector) =>
			selector === issued.selector ? stored : null,
		);

		expect(record).toBeNull();
	});

	test("selector/validator differ on every issue call", async () => {
		const apiToken = new ApiToken();

		const first = await apiToken.issue();
		const second = await apiToken.issue();

		expect(first.selector).not.toBe(second.selector);
		expect(first.token).not.toBe(second.token);
		expect(first.validatorHash).not.toBe(second.validatorHash);
	});
});
