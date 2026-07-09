/**
 * Stateless, purpose-scoped tokens.
 *
 * Holds no storage. By including a "fingerprint" derived from the target data
 * (e.g. a fragment of the password hash, or the email itself) in the
 * HMAC-SHA256 signed content, the token is automatically invalidated the
 * moment the target data changes (e.g. invalidating a password-reset token
 * after the password has since been changed).
 *
 * The fingerprint is never included in the `payload` (the base64url portion
 * carried in the token string) — only in the signed content. Because `payload`
 * is base64url, not encryption, embedding secret material such as a password
 * hash fragment directly in the payload would let it be read back out of the
 * token string itself (which is often sent as a URL in an email body).
 * Including it only in the signed content ensures the fingerprint value itself
 * cannot be recovered from the token string, while still allowing verification
 * by recomputing and comparing.
 */
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import { constantTimeEqual } from "../support/constant_time.js";
import { warnWeakSecrets } from "../support/secret_strength_warning.js";

export type DataTokenOptions = {
	/**
	 * List of signing secrets. At least one is required. Signing uses the first
	 * entry; verification is attempted against all entries. Use high-entropy
	 * random values equivalent to 32 bytes. Do not use low-entropy values such as
	 * human-chosen passphrases, which are vulnerable to brute force.
	 */
	secrets: string[];
	/** Purpose identifier for the token, preventing reuse across purposes (e.g. "oven:password_reset"). */
	purpose: string;
	/** Token validity period in seconds. */
	expiresInSeconds: number;
};

/** A function resolving the current fingerprint for `identity` at verification time. Returns `null` if the target no longer exists. */
export type FingerprintResolver = (identity: string) => string | null | Promise<string | null>;

/** The token's payload portion (before JSON serialization). */
type DataTokenPayload = {
	identity: string;
	purpose: string;
	expiresAt: number;
};

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

const importHmacKey = (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", new TextEncoder().encode(secret), HMAC_ALGORITHM, false, [
		"sign",
		"verify",
	]);

/** Builds the canonical string to be signed from `payloadB64` and `fingerprint`. */
const canonicalTarget = (payloadB64: string, fingerprint: string): string =>
	`${payloadB64}.${fingerprint}`;

/** Validates a `JSON.parse`d value as a `DataTokenPayload` and returns it. Returns `null` if malformed. */
const parsePayload = (raw: string): DataTokenPayload | null => {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"identity" in parsed &&
			"purpose" in parsed &&
			"expiresAt" in parsed &&
			typeof parsed.identity === "string" &&
			typeof parsed.purpose === "string" &&
			typeof parsed.expiresAt === "number"
		) {
			return { identity: parsed.identity, purpose: parsed.purpose, expiresAt: parsed.expiresAt };
		}
		return null;
	} catch {
		return null;
	}
};

/**
 * Issues and verifies stateless, purpose-scoped tokens. `generate`/`verify` are
 * declared as arrow-function class fields because they may be passed by
 * reference from handlers.
 */
export class DataToken {
	private readonly secrets: string[];
	private readonly purpose: string;
	private readonly expiresInSeconds: number;

	/**
	 * In-instance memoization of the `importHmacKey` result. Since the
	 * constructor cannot `await` asynchronous work, key import is deferred to
	 * first access and its `Promise` itself is cached (the same pattern used by
	 * `UrlSigner`'s `keyCache`).
	 */
	private readonly keyCache = new Map<string, Promise<CryptoKey>>();

	constructor(options: DataTokenOptions) {
		if (options.secrets.length === 0) {
			throw new Error("DataToken requires at least one secret in `secrets`");
		}
		if (!Number.isInteger(options.expiresInSeconds) || options.expiresInSeconds <= 0) {
			throw new Error("DataToken requires a positive integer for `expiresInSeconds`");
		}
		if (options.purpose === "") {
			throw new Error("DataToken requires `purpose` to be set");
		}
		warnWeakSecrets(options.secrets, "DataToken");

		this.secrets = options.secrets;
		this.purpose = options.purpose;
		this.expiresInSeconds = options.expiresInSeconds;
	}

	/** Returns the `CryptoKey` corresponding to `secret`, memoized. */
	private importKeyCached(secret: string): Promise<CryptoKey> {
		const cached = this.keyCache.get(secret);
		if (cached) return cached;

		const promise = importHmacKey(secret);
		this.keyCache.set(secret, promise);
		return promise;
	}

	/** Returns the HMAC signature bytes for `canonical`, signed with `secret`. */
	private async computeSignature(canonical: string, secret: string): Promise<Uint8Array> {
		const key = await this.importKeyCached(secret);
		const signature = await crypto.subtle.sign(
			HMAC_ALGORITHM.name,
			key,
			new TextEncoder().encode(canonical),
		);
		return new Uint8Array(signature);
	}

	/**
	 * Issues a token for `identity`. `fingerprint` is a value derived from the
	 * target data (e.g. a password hash fragment or an email) and is included
	 * only in the signed content (see the module JSDoc for the rationale).
	 * Signing always uses `secrets[0]`.
	 */
	readonly generate = async (identity: string, fingerprint: string): Promise<string> => {
		const payload: DataTokenPayload = {
			identity,
			purpose: this.purpose,
			expiresAt: Math.floor(Date.now() / 1000) + this.expiresInSeconds,
		};
		const payloadB64 = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));

		// The constructor rejects `secrets.length === 0`, so the first element always exists.
		const signature = await this.computeSignature(
			canonicalTarget(payloadB64, fingerprint),
			this.secrets[0],
		);
		return `${payloadB64}.${encodeBase64Url(signature)}`;
	};

	/**
	 * Verifies a token and, on success, returns `identity`. Malformed format,
	 * purpose mismatch, expiry, missing target, or signature mismatch against
	 * every secret all result in `null` (fail-soft).
	 *
	 * `fingerprint` resolves the current fingerprint from `payload.identity`. At
	 * this point `identity` has not yet been signature-verified, but
	 * `fingerprint` is expected to be a side-effect-free function that merely
	 * reads a record, so this is acceptable (a signature mismatch still yields
	 * `null` in the end).
	 */
	readonly verify = async (
		token: string,
		fingerprint: FingerprintResolver,
	): Promise<string | null> => {
		const separatorIndex = token.indexOf(".");
		if (separatorIndex === -1) return null;

		const payloadB64 = token.slice(0, separatorIndex);
		const signatureB64 = token.slice(separatorIndex + 1);
		if (payloadB64 === "" || signatureB64 === "") return null;

		let payloadJson: string;
		try {
			payloadJson = new TextDecoder().decode(decodeBase64Url(payloadB64));
		} catch {
			return null;
		}

		const payload = parsePayload(payloadJson);
		if (!payload) return null;
		if (payload.purpose !== this.purpose) return null;
		if (payload.expiresAt < Math.floor(Date.now() / 1000)) return null;

		const currentFingerprint = await fingerprint(payload.identity);
		if (currentFingerprint === null) return null;

		let signature: Uint8Array<ArrayBuffer>;
		try {
			signature = decodeBase64Url(signatureB64);
		} catch {
			return null;
		}

		const canonical = canonicalTarget(payloadB64, currentFingerprint);
		for (const secret of this.secrets) {
			const expected = await this.computeSignature(canonical, secret);
			if (constantTimeEqual(signature, expected)) {
				return payload.identity;
			}
		}
		return null;
	};
}
