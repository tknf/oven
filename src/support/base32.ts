/**
 * Shared RFC 4648 Base32 encode/decode helpers.
 *
 * `auth/totp.ts` needs Base32 to encode a random TOTP secret into the
 * alphanumeric string form `otpauth://` URLs and authenticator apps expect
 * (RFC 4648 §6; there is no `btoa`/`atob` equivalent for Base32, unlike
 * Base64URL in `base64url.ts`). Implemented from scratch on plain bitwise
 * arithmetic so it works in Workers, browsers, and Node alike, with no
 * dependency beyond `Uint8Array`.
 */

/** RFC 4648 §6 Base32 alphabet. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encodes `bytes` as an uppercase, unpadded Base32 string. */
export const encodeBase32 = (bytes: Uint8Array): string => {
	let bitBuffer = 0;
	let bits = 0;
	let output = "";

	for (const byte of bytes) {
		bitBuffer = (bitBuffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += ALPHABET[(bitBuffer >>> (bits - 5)) & 0x1f];
			bits -= 5;
		}
	}
	/** A trailing partial group (1-4 leftover bits) is padded with zero bits on the right, per RFC 4648 §6. */
	if (bits > 0) {
		output += ALPHABET[(bitBuffer << (5 - bits)) & 0x1f];
	}

	return output;
};

/**
 * Decodes a Base32 string into a `Uint8Array<ArrayBuffer>` (pinned explicitly
 * for `BufferSource` constraints such as `crypto.subtle.importKey`, same
 * reason as `decodeBase64Url` in `base64url.ts`). Tolerant of lowercase input
 * and trailing `=` padding; throws `TypeError` on any other character outside
 * the RFC 4648 §6 alphabet (mirroring `decodeBase64Url`'s "throws on invalid
 * input" contract, since Base32 has no built-in decoder to delegate to).
 */
export const decodeBase32 = (value: string): Uint8Array<ArrayBuffer> => {
	const normalized = value.toUpperCase().replace(/=+$/, "");
	let bitBuffer = 0;
	let bits = 0;
	const bytes: number[] = [];

	for (const char of normalized) {
		const index = ALPHABET.indexOf(char);
		if (index === -1) {
			throw new TypeError(`decodeBase32: "${char}" is not a valid Base32 character`);
		}
		bitBuffer = (bitBuffer << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((bitBuffer >>> bits) & 0xff);
		}
	}

	return Uint8Array.from(bytes);
};
