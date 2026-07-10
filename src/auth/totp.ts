/**
 * TOTP (RFC 6238, Time-Based One-Time Password) primitives on top of HOTP
 * (RFC 4226), built entirely on Web Crypto (`crypto.getRandomValues`,
 * `crypto.subtle`) so it works in Workers, browsers, and Node alike with no
 * dependency beyond `support/base32.ts` and `support/constant_time.ts`.
 *
 * These are standalone primitives, not tied to admin accounts: `generateTotpCode`/
 * `verifyTotpCode` take the secret directly, so any caller (admin operator 2FA,
 * an app's own user-facing 2FA, ...) can use them without going through
 * `admin/*_admin_accounts.ts`.
 *
 * **Deliberately does not reuse `support/hmac.ts`**: that module hardcodes
 * HMAC-SHA256 for its callers (`DataToken`, `CookieSessionStorage`,
 * `UrlSigner`), while RFC 6238 defaults to HMAC-SHA1 and optionally supports
 * SHA-256/SHA-512 (`TotpAlgorithm`). Each function here imports its own
 * `CryptoKey` inline via `crypto.subtle.importKey` with the requested
 * algorithm, rather than bending `hmac.ts` to a second hash.
 *
 * **Replay-protection contract**: `verifyTotpCode` returns the matched time
 * step counter (not just `true`/`false`) specifically so a caller can persist
 * it and reject a future verification against that same step — a code is
 * otherwise valid for the caller's whole `periodSeconds` window and could be
 * replayed by anyone who observes it in that time. See
 * `SQLiteAdminAccounts#verifyTotp` (and its Postgres/MySQL counterparts) for
 * a concrete implementation of that persistence.
 */
import { decodeBase32, encodeBase32 } from "../support/base32.js";
import { constantTimeEqual } from "../support/constant_time.js";

/** HMAC hash algorithm backing HOTP/TOTP code generation. RFC 6238 defaults to `"SHA-1"`; `"SHA-256"`/`"SHA-512"` are optional extensions some authenticator apps also support. */
export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

/** Options for `buildOtpauthUrl`. */
export type BuildOtpauthUrlOptions = {
	/** Base32-encoded shared secret (as returned by `generateTotpSecret`). */
	secret: string;
	/** Issuer name shown by the authenticator app (e.g. the app or organization name). */
	issuer: string;
	/** Account label shown alongside the issuer (e.g. the operator's username). */
	accountName: string;
	/** Number of digits the generated code has. Defaults to 6. */
	digits?: number;
	/** Length, in seconds, of one time step. Defaults to 30. */
	periodSeconds?: number;
	/** HMAC hash algorithm. Defaults to `"SHA-1"` (the only algorithm every mainstream authenticator app supports). */
	algorithm?: TotpAlgorithm;
};

/** Options for `generateTotpCode`. */
export type GenerateTotpCodeOptions = {
	/** Base32-encoded shared secret. */
	secret: string;
	/** The moment to generate a code for, as epoch milliseconds. Defaults to `Date.now()`. */
	timestampMs?: number;
	/** Number of digits the generated code has. Defaults to 6. */
	digits?: number;
	/** Length, in seconds, of one time step. Defaults to 30. */
	periodSeconds?: number;
	/** HMAC hash algorithm. Defaults to `"SHA-1"`. */
	algorithm?: TotpAlgorithm;
};

/** Options for `verifyTotpCode`. */
export type VerifyTotpCodeOptions = {
	/** Base32-encoded shared secret. */
	secret: string;
	/** The code submitted by the operator. */
	code: string;
	/** The moment to verify against, as epoch milliseconds. Defaults to `Date.now()`. */
	timestampMs?: number;
	/** Number of digits an accepted code has. Defaults to 6. */
	digits?: number;
	/** Length, in seconds, of one time step. Defaults to 30. */
	periodSeconds?: number;
	/**
	 * Number of time steps of clock drift to accept on either side of the
	 * current step (e.g. `1` accepts the previous, current, and next step).
	 * Defaults to 1.
	 */
	driftSteps?: number;
	/** HMAC hash algorithm. Defaults to `"SHA-1"`. Must match what the secret was provisioned with. */
	algorithm?: TotpAlgorithm;
};

/**
 * Generates a random TOTP secret, Base32-encoded (the form `otpauth://` URLs
 * and authenticator apps expect). `byteLength` defaults to 20 (160 bits),
 * matching RFC 4226's recommended HOTP secret length for HMAC-SHA1.
 */
export const generateTotpSecret = (byteLength = 20): string =>
	encodeBase32(crypto.getRandomValues(new Uint8Array(byteLength)));

/**
 * Builds an `otpauth://totp/...` provisioning URL (the de facto "Key URI
 * Format" understood by Google Authenticator, Authy, and most other TOTP
 * apps) for scanning or manual entry. `issuer` and `accountName` are each
 * percent-encoded; `algorithm`'s hyphen is stripped (`"SHA-1"` → `SHA1`) to
 * match the convention every authenticator app expects for the `algorithm`
 * query parameter. QR rendering is out of scope here — the app renders this
 * URL into a QR code (or shows it for manual entry) with its own choice of
 * library.
 */
export const buildOtpauthUrl = ({
	secret,
	issuer,
	accountName,
	digits = 6,
	periodSeconds = 30,
	algorithm = "SHA-1",
}: BuildOtpauthUrlOptions): string => {
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
	const params = new URLSearchParams({
		secret,
		issuer,
		algorithm: algorithm.replace("-", ""),
		digits: String(digits),
		period: String(periodSeconds),
	});
	return `otpauth://totp/${label}?${params.toString()}`;
};

/** Imports `secret` (Base32-decoded) as an HMAC `CryptoKey` for the given `algorithm`. */
const importTotpKey = (secret: string, algorithm: TotpAlgorithm): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", decodeBase32(secret), { name: "HMAC", hash: algorithm }, false, [
		"sign",
	]);

/**
 * Encodes a non-negative HOTP counter as an 8-byte big-endian buffer (RFC
 * 4226 §5.2). The return type is pinned to `Uint8Array<ArrayBuffer>` (rather
 * than the default `ArrayBufferLike`) to satisfy `crypto.subtle.sign`'s
 * `BufferSource` constraint (same reason as `decodeBase64Url` in
 * `support/base64url.ts`).
 */
const encodeCounter = (counter: number): Uint8Array<ArrayBuffer> => {
	const bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setBigUint64(0, BigInt(counter), false);
	return bytes;
};

/**
 * Computes one HOTP code (RFC 4226 §5.3): HMAC the 8-byte counter with
 * `secret`, then apply dynamic truncation and reduce mod `10^digits`,
 * zero-padded to `digits`.
 */
const hotp = async (
	secret: string,
	counter: number,
	digits: number,
	algorithm: TotpAlgorithm,
): Promise<string> => {
	const key = await importTotpKey(secret, algorithm);
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encodeCounter(counter)));

	/** Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte selects a 4-byte offset. */
	const offset = signature[signature.length - 1] & 0x0f;
	const binary =
		((signature[offset] & 0x7f) << 24) |
		((signature[offset + 1] & 0xff) << 16) |
		((signature[offset + 2] & 0xff) << 8) |
		(signature[offset + 3] & 0xff);
	const code = binary % 10 ** digits;
	return code.toString().padStart(digits, "0");
};

/** Generates the current (or `timestampMs`-relative) TOTP code for `secret`. */
export const generateTotpCode = ({
	secret,
	timestampMs = Date.now(),
	digits = 6,
	periodSeconds = 30,
	algorithm = "SHA-1",
}: GenerateTotpCodeOptions): Promise<string> => {
	const counter = Math.floor(timestampMs / 1000 / periodSeconds);
	return hotp(secret, counter, digits, algorithm);
};

/**
 * Verifies `code` against `secret` within a `driftSteps`-wide window around
 * `timestampMs`'s time step, returning the MATCHED step counter (for the
 * caller to persist as replay protection — see the module JSDoc) or `null`
 * when no step in the window matches.
 *
 * A structurally invalid `code` (wrong length, or containing anything but
 * digits) is rejected up front without computing any HOTP code. Otherwise
 * every candidate step in `[current - driftSteps, current + driftSteps]` is
 * computed and compared via `constantTimeEqual` (over UTF-8 bytes)
 * REGARDLESS of whether an earlier step already matched: the loop always
 * runs to completion (uniform work independent of where, or whether, a match
 * falls in the window), and the first match encountered is the one returned.
 */
export const verifyTotpCode = async ({
	secret,
	code,
	timestampMs = Date.now(),
	digits = 6,
	periodSeconds = 30,
	driftSteps = 1,
	algorithm = "SHA-1",
}: VerifyTotpCodeOptions): Promise<number | null> => {
	if (code.length !== digits || !/^[0-9]+$/.test(code)) return null;

	const currentStep = Math.floor(timestampMs / 1000 / periodSeconds);
	const submitted = new TextEncoder().encode(code);
	let matchedStep: number | null = null;

	for (let delta = -driftSteps; delta <= driftSteps; delta++) {
		const step = currentStep + delta;
		const candidate = await hotp(secret, step, digits, algorithm);
		if (constantTimeEqual(submitted, new TextEncoder().encode(candidate)) && matchedStep === null) {
			matchedStep = step;
		}
	}

	return matchedStep;
};
