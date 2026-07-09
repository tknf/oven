/**
 * Issues presigned GET URLs for an S3-compatible API (AWS S3, R2, MinIO,
 * etc.). Credentials (access keys) are injected as plain values via the
 * constructor, and this class knows nothing about binding-specific types
 * such as `R2Bucket` (nor does it bring in any HTTP-layer knowledge).
 *
 * Signing is done via `aws4fetch`'s `AwsClient` (Workers-compatible and
 * lightweight). The R2 hostname (`*.r2.cloudflarestorage.com`) is
 * automatically detected by aws4fetch as `s3`/`auto` even without an explicit
 * `service`/`region`, so the constructor does not specify them (matching the
 * "Presigned URLs (Workers)" example at
 * developers.cloudflare.com/r2/objects/upload-objects/).
 */
import { AwsClient } from "aws4fetch";
import type { Presigner } from "./presigner.js";
import { encodeS3Key } from "./s3_storage.js";

export type S3UrlSignerConfig = {
	/** Base URL without the bucket name (e.g. `https://s3.us-east-1.amazonaws.com` or `https://<account_id>.r2.cloudflarestorage.com`). */
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
};

/** Issues S3-compatible presigned GET URLs (AWS S3, R2, MinIO, etc.). */
export class S3UrlSigner implements Presigner {
	private readonly client: AwsClient;
	private readonly endpoint: string;
	private readonly bucket: string;

	constructor(config: S3UrlSignerConfig) {
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		});
		this.endpoint = config.endpoint;
		this.bucket = config.bucket;
	}

	/**
	 * Issues a presigned GET URL for `key`. It expires after `expiresInSeconds`.
	 *
	 * `key` is `encodeURIComponent`-encoded per path segment (`/`-separated,
	 * via `encodeS3Key`). With naive string concatenation, a `key` containing
	 * `?` or `#` would unintentionally truncate the path at URL-parsing time,
	 * producing a signature for a different object (`/` itself must remain a
	 * separator and is excluded from encoding). A `key` containing `..`
	 * segments could escape the bucket prefix, so `encodeS3Key` throws for
	 * that case. An empty `key` would produce a signed URL for the bucket
	 * root, so it is explicitly rejected.
	 */
	async presignGet(key: string, expiresInSeconds: number): Promise<string> {
		if (key === "") {
			throw new Error("key must not be empty");
		}

		const url = new URL(`${this.endpoint}/${this.bucket}/${encodeS3Key(key)}`);
		url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));

		const signed = await this.client.sign(new Request(url, { method: "GET" }), {
			aws: { signQuery: true },
		});
		return signed.url;
	}
}
