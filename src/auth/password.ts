/**
 * Password hash generation and verification using WebCrypto (PBKDF2-HMAC-SHA256).
 *
 * The default iteration count is 100,000. `crypto.subtle` in workerd throws
 * `NotSupportedError` when PBKDF2's iteration count exceeds 100,000 (confirmed
 * on the real runtime), so do not use a higher value such as 600,000 when
 * running on Workers. When running exclusively on a non-Workers runtime such
 * as Node, the iteration count can be raised to the OWASP-recommended value
 * (600,000 or more) for PBKDF2-HMAC-SHA256. Since the iteration count is
 * self-described in the hash string, `verifyPassword` can verify both correctly
 * even in a mixed environment (e.g. a database containing hashes generated
 * with different iteration counts), following whichever count was stored.
 *
 * Storage format: `pbkdf2$<iterations>$<salt(base64)>$<hash(base64)>`
 */
import { decodeBase64, encodeBase64 } from "hono/utils/encode";
import { constantTimeEqual } from "../support/constant_time.js";

const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

/**
 * The salt type is explicitly `Uint8Array<ArrayBuffer>`. A plain `Uint8Array`
 * (whose default type parameter is `ArrayBufferLike`) does not satisfy
 * `crypto.subtle.deriveBits`'s `BufferSource` constraint. `decodeBase64`'s
 * (hono/utils/encode) return value satisfies this type as-is.
 */
const deriveBits = async (password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) => {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const derived = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		keyMaterial,
		DERIVED_KEY_BITS,
	);
	return new Uint8Array(derived);
};

/**
 * Generates a password hash in a self-describing format that includes the
 * salt and iteration count.
 *
 * `options.iterations` overrides the iteration count (defaults to 100,000).
 * Throws if given a value that is not a positive integer.
 */
export const hashPassword = async (
	password: string,
	options?: { iterations?: number },
): Promise<string> => {
	const iterations = options?.iterations ?? ITERATIONS;
	if (!Number.isInteger(iterations) || iterations <= 0) {
		throw new Error("`iterations` must be a positive integer");
	}

	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await deriveBits(password, salt, iterations);
	return `pbkdf2$${iterations}$${encodeBase64(salt.buffer)}$${encodeBase64(hash.buffer)}`;
};

/**
 * Verifies a match against a stored hash. Malformed input (wrong number of
 * segments, non-numeric iteration count, invalid base64, etc.) returns false
 * rather than throwing.
 *
 * Usage guide: even when an account does not exist, call this function against
 * a fixed dummy hash (pre-generated with `hashPassword`) so that PBKDF2 always
 * runs. This prevents account enumeration (guessing whether a user exists)
 * via response-time differences.
 */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
	const parts = stored.split("$");
	if (parts.length !== 4) return false;

	const [scheme, iterationsRaw, saltB64, hashB64] = parts;
	if (scheme !== "pbkdf2") return false;

	const iterations = Number(iterationsRaw);
	if (!Number.isInteger(iterations) || iterations <= 0) return false;

	try {
		const salt = decodeBase64(saltB64);
		const expected = decodeBase64(hashB64);
		const actual = await deriveBits(password, salt, iterations);
		return constantTimeEqual(actual, expected);
	} catch {
		return false;
	}
};
