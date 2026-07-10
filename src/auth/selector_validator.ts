/**
 * Shared primitives for the selector/validator token scheme used by
 * `ApiToken` and `RememberToken`.
 *
 * Both classes split their token string into `${selector}.${validator}`:
 * `selector` is kept in plaintext as the lookup key, while only the
 * SHA-256 hash of `validator` is stored, so a leaked store alone cannot be
 * replayed as a valid token. See each class's module JSDoc for the full
 * rationale (they differ in whether the token rotates on use). This module
 * only extracts the byte-length constants and the two small functions that
 * are byte-for-byte identical between the two classes; it is an internal
 * helper and is not re-exported from `auth/index.ts`.
 */
import { encodeBase64Url } from "../support/base64url.js";

/** Byte length of the random `selector` portion. */
export const SELECTOR_BYTE_LENGTH = 16;
/** Byte length of the random `validator` portion. */
export const VALIDATOR_BYTE_LENGTH = 32;

/** Returns a random value of `byteLength` bytes as a base64url string. */
export const randomToken = (byteLength: number): string =>
	encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));

/** Returns the SHA-256 hash of `validator` as a base64url string. */
export const hashValidator = async (validator: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(validator));
	return encodeBase64Url(new Uint8Array(digest));
};
