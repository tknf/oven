/**
 * Reversible encryption using AES-256-GCM (Web Crypto). Intended only for "encrypt now, recover
 * the original value later" use cases (e.g. storing third-party API keys) — **never use this
 * for storing passwords** (passwords should be irreversible, which is what the PBKDF2 hashing
 * in `password.ts` handles).
 *
 * Key derivation runs `secret` (a string) through `SHA-256` and imports the resulting 32 bytes
 * as an AES-256-GCM key via `crypto.subtle.importKey`. Since this is a single `SHA-256` pass
 * with no stretching, `secrets` is expected to already carry sufficient entropy (see the JSDoc
 * on `EncrypterOptions.secrets` for details). `secrets: string[]` supports key rotation:
 * encryption always uses the first entry (`secrets[0]`), while decryption tries every key in
 * order (the same convention used by `CookieSessionStorage` and `csrf.ts`).
 *
 * The output format is `<IV(Base64URL)>.<ciphertext(Base64URL)>`. The IV is a random 12-byte
 * value generated per call via `crypto.getRandomValues`, and the GCM authentication tag is
 * embedded at the end of the ciphertext (per the Web Crypto `AES-GCM` spec). Since the IV is
 * only 96 bits of randomness, NIST SP800-38D guidance recommends avoiding roughly 2^32 or more
 * encryptions under the same key (not reachable in normal usage).
 *
 * **`decrypt` fails soft**: malformed input, tampering, or key mismatch all result in `null`
 * being returned rather than an exception. This mirrors how `SignedCookieAccessor` returns
 * `false` rather than throwing on tampering detection, so that callers passed broken input can
 * handle decryption failure naturally via a branch.
 */
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import { warnWeakSecrets } from "../support/secret_strength_warning.js";

export type EncrypterOptions = {
	/**
	 * List of secrets used for key derivation. At least one is required. Encryption uses the
	 * first entry; decryption tries every entry. Because key derivation is a single SHA-256
	 * pass with no stretching, use high-entropy random values equivalent to 32 bytes. Do not
	 * use low-entropy values such as human-chosen passphrases, which are vulnerable to
	 * brute-force attacks.
	 */
	secrets: string[];
};

const AES_ALGORITHM = "AES-GCM";
const IV_BYTES = 12;

const deriveAesKey = async (secret: string): Promise<CryptoKey> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return crypto.subtle.importKey("raw", digest, AES_ALGORITHM, false, ["encrypt", "decrypt"]);
};

export class Encrypter {
	private readonly secrets: string[];

	/**
	 * Instance-level memoization of `deriveAesKey` results. Since a constructor cannot `await`
	 * async work, key derivation is deferred to first access and its `Promise` itself is
	 * cached (the same convention used by `keyCache` in `CookieSessionStorage`).
	 */
	private readonly keyCache = new Map<string, Promise<CryptoKey>>();

	constructor(options: EncrypterOptions) {
		if (options.secrets.length === 0) {
			throw new Error("Encrypter requires at least one secret in secrets");
		}
		warnWeakSecrets(options.secrets, "Encrypter");
		this.secrets = options.secrets;
	}

	/** Returns the `CryptoKey` for `secret`, memoizing the result. */
	private importKeyCached(secret: string): Promise<CryptoKey> {
		const cached = this.keyCache.get(secret);
		if (cached) return cached;

		const promise = deriveAesKey(secret);
		this.keyCache.set(secret, promise);
		return promise;
	}

	/**
	 * Encrypts `plaintext`. Always uses the first key, `secrets[0]`. An arrow-function class
	 * field so it can be passed by reference.
	 */
	readonly encrypt = async (plaintext: string): Promise<string> => {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		// The constructor rejects `secrets.length === 0`, so the first element always exists.
		const key = await this.importKeyCached(this.secrets[0]);
		const ciphertext = await crypto.subtle.encrypt(
			{ name: AES_ALGORITHM, iv },
			key,
			new TextEncoder().encode(plaintext),
		);
		return `${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
	};

	/**
	 * Decrypts `value`. Tries each entry in `secrets` in order and returns the plaintext from
	 * the first one that succeeds. Returns `null` on malformed input or if decryption fails
	 * with every key (tampering or key mismatch). An arrow-function class field so it can be
	 * passed by reference.
	 */
	readonly decrypt = async (value: string): Promise<string | null> => {
		const separatorIndex = value.indexOf(".");
		if (separatorIndex === -1) return null;

		const ivBase64 = value.slice(0, separatorIndex);
		const ciphertextBase64 = value.slice(separatorIndex + 1);

		let iv: Uint8Array<ArrayBuffer>;
		let ciphertext: Uint8Array<ArrayBuffer>;
		try {
			iv = decodeBase64Url(ivBase64);
			ciphertext = decodeBase64Url(ciphertextBase64);
		} catch {
			return null;
		}

		for (const secret of this.secrets) {
			const key = await this.importKeyCached(secret);
			try {
				const plaintext = await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext);
				return new TextDecoder().decode(plaintext);
			} catch {
				// An authentication tag mismatch (tampering or wrong key) throws. Try the next key.
			}
		}

		return null;
	};
}
