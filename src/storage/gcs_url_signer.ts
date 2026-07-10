/**
 * Issues presigned GET URLs for Google Cloud Storage using the V4 signing
 * algorithm (`GOOG4-RSA-SHA256`), following the manual signing steps
 * documented at
 * cloud.google.com/storage/docs/access-control/signing-urls-manually.
 *
 * Unlike `S3UrlSigner` (HMAC-SHA256 over a shared secret via aws4fetch), GCS
 * V4 signing uses a service account's RSA private key
 * (`RSASSA-PKCS1-v1_5` + SHA-256, signed via Web Crypto — no third-party
 * signing library is needed). The `clientEmail`/`privateKeyPem` pair are the
 * `client_email`/`private_key` fields of a downloaded service account JSON
 * key.
 *
 * URLs are built path-style (`https://storage.googleapis.com/<bucket>/<key>`,
 * matching `S3Storage`/`S3UrlSigner`'s convention) rather than
 * virtual-hosted-style (`https://<bucket>.storage.googleapis.com/<key>`);
 * both are valid endpoints for the GCS XML API that V4 signing targets, and
 * the `host` used in the canonical request must match whichever style is
 * used to make the request.
 */
import type { Presigner } from "./presigner.js";
import { encodeS3Key } from "./s3_storage.js";

export type GcsUrlSignerConfig = {
	bucket: string;
	/** Service account email (the JSON key's `client_email`). Forms the `X-Goog-Credential` scope. */
	clientEmail: string;
	/** Service account private key, PEM-encoded PKCS8 (the JSON key's `private_key`). Imported once and cached for the life of the instance. */
	privateKeyPem: string;
	/** Request host used both in the signed URL and the canonical request's `host` header. Defaults to `"storage.googleapis.com"` (path-style). */
	host?: string;
};

const DEFAULT_HOST = "storage.googleapis.com";

/** GCS's documented bounds for `X-Goog-Expires` (in seconds): 1 second to 7 days. */
const MIN_EXPIRES_SECONDS = 1;
const MAX_EXPIRES_SECONDS = 604800;

/** Issues GCS V4 presigned GET URLs, signed with a service account's RSA private key. */
export class GcsUrlSigner implements Presigner {
	private readonly bucket: string;
	private readonly clientEmail: string;
	private readonly host: string;
	private readonly signingKey: Promise<CryptoKey>;

	constructor(config: GcsUrlSignerConfig) {
		this.bucket = config.bucket;
		this.clientEmail = config.clientEmail;
		this.host = config.host ?? DEFAULT_HOST;
		this.signingKey = importPkcs8SigningKey(config.privateKeyPem);
		// A malformed PEM rejects immediately, before any caller has a chance
		// to await `presignGet`. Attaching a no-op handler here marks the
		// promise as handled for Node's unhandled-rejection tracking without
		// swallowing the error: `presignGet` still awaits `this.signingKey`
		// directly and surfaces the real rejection there.
		this.signingKey.catch(() => {});
	}

	/**
	 * Issues a presigned GET URL for `key`. It expires after `expiresInSeconds`
	 * (must be within GCS's documented 1..604800 second bounds).
	 *
	 * `key` is encoded the same way `S3Storage`/`S3UrlSigner` encode an object
	 * key: `encodeURIComponent`-encoded per path segment (`/` kept as the
	 * separator, `..` segments rejected to prevent escaping the bucket
	 * prefix). GCS's own manual-signing sample encodes a key the same way
	 * (percent-encoding with `/` and `~` left as safe characters, which is
	 * exactly what `encodeURIComponent` already does), so reusing
	 * `encodeS3Key` here does not double-encode anything. An empty `key`
	 * would sign the bucket root, so it is explicitly rejected.
	 */
	async presignGet(key: string, expiresInSeconds: number): Promise<string> {
		if (key === "") {
			throw new Error("key must not be empty");
		}
		if (expiresInSeconds < MIN_EXPIRES_SECONDS || expiresInSeconds > MAX_EXPIRES_SECONDS) {
			throw new Error(
				`expiresInSeconds must be between ${MIN_EXPIRES_SECONDS} and ${MAX_EXPIRES_SECONDS} (GCS's documented bounds), got ${expiresInSeconds}`,
			);
		}
		const path = `/${this.bucket}/${encodeS3Key(key)}`;

		const now = new Date();
		const requestTimestamp = formatRequestTimestamp(now);
		const dateStamp = requestTimestamp.slice(0, 8);
		const credentialScope = `${dateStamp}/auto/storage/goog4_request`;

		const canonicalQueryString = buildCanonicalQueryString({
			"X-Goog-Algorithm": "GOOG4-RSA-SHA256",
			"X-Goog-Credential": `${this.clientEmail}/${credentialScope}`,
			"X-Goog-Date": requestTimestamp,
			"X-Goog-Expires": String(expiresInSeconds),
			"X-Goog-SignedHeaders": "host",
		});

		const canonicalRequest = [
			"GET",
			path,
			canonicalQueryString,
			`host:${this.host}`,
			"",
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");

		const stringToSign = [
			"GOOG4-RSA-SHA256",
			requestTimestamp,
			credentialScope,
			await sha256Hex(canonicalRequest),
		].join("\n");

		const signature = await signHex(await this.signingKey, stringToSign);

		return `https://${this.host}${path}?${canonicalQueryString}&X-Goog-Signature=${signature}`;
	}
}

/** Builds the `YYYYMMDD'T'HHMMSS'Z'` timestamp GCS's V4 algorithm expects, from a `Date` in UTC. */
const formatRequestTimestamp = (date: Date): string =>
	date.toISOString().replace(/[:-]|\.\d{3}/g, "");

/**
 * Builds a canonical query string: keys sorted alphabetically, both keys and
 * values percent-encoded per RFC 3986, joined with `&`. `encodeURIComponent`
 * leaves `! ' ( ) *` unescaped, so those are escaped separately.
 */
const buildCanonicalQueryString = (params: Record<string, string>): string =>
	Object.keys(params)
		.sort()
		.map((key) => `${encodeRfc3986Component(key)}=${encodeRfc3986Component(params[key])}`)
		.join("&");

const encodeRfc3986Component = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

const sha256Hex = async (input: string): Promise<string> =>
	toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));

const signHex = async (key: CryptoKey, stringToSign: string): Promise<string> =>
	toHex(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(stringToSign)));

const toHex = (buffer: ArrayBuffer): string =>
	Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");

/**
 * Imports a PKCS8 PEM-encoded RSA private key (a service account JSON key's
 * `private_key` field) for `RSASSA-PKCS1-v1_5`/SHA-256 signing. Any parse or
 * import failure surfaces as a rejected promise with a clear message (it is
 * awaited lazily inside `presignGet`, not at construction time).
 */
const importPkcs8SigningKey = async (pem: string): Promise<CryptoKey> => {
	const pkcs8 = pemToPkcs8(pem);
	try {
		return await crypto.subtle.importKey(
			"pkcs8",
			pkcs8,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["sign"],
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`privateKeyPem is not a valid PKCS8 RSA private key: ${reason}`);
	}
};

/** Strips the PEM header/footer and whitespace, then base64-decodes the remaining PKCS8 body. */
const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
	if (!match) {
		throw new Error(
			'privateKeyPem must be a PEM block delimited by "-----BEGIN PRIVATE KEY-----"/"-----END PRIVATE KEY-----" (the service account JSON key\'s private_key field)',
		);
	}
	const binary = atob(match[1].replace(/\s+/g, ""));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
};
