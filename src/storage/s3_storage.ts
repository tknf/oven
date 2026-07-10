/**
 * `Storage` implementation backed by an S3-compatible API (AWS S3, R2, MinIO,
 * GCS interop, etc.). Signing is done via `aws4fetch`'s `AwsClient`
 * (Workers-compatible and lightweight).
 *
 * Because `aws4fetch` needs the request body to compute the SigV4 signature,
 * a `ReadableStream` passed to `put` is read fully into an `ArrayBuffer`
 * before being sent (streaming upload is not supported). The maximum number
 * of bytes read can be capped via `S3StorageConfig#maxBytes`; set this to
 * avoid OOM under a Worker's memory limit.
 *
 * Once the (now fully-buffered) body exceeds `MULTIPART_PART_SIZE_BYTES`
 * (100 MiB, mirroring the R2 adapter's threshold convention), `put`
 * automatically switches to S3's Multipart Upload API
 * (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`, aborting
 * via `AbortMultipartUpload` on failure) instead of a single `PUT`.
 */
import { AwsClient } from "aws4fetch";
import { timeoutSignal } from "../support/fetch_timeout.js";
import { Storage, type StorageObject } from "./storage.js";

export type S3StorageConfig = {
	/** Base URL without the bucket name (e.g. `https://s3.us-east-1.amazonaws.com` or `https://<account_id>.r2.cloudflarestorage.com`). */
	endpoint: string;
	bucket: string;
	region?: string;
	accessKeyId: string;
	secretAccessKey: string;
	/** For test injection. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/**
	 * Maximum number of bytes accepted by `put`. Unlimited if omitted (the
	 * previous behavior). Because aws4fetch's signing requirement forces
	 * streams to be read fully into memory, allowing unlimited uploads under
	 * a Worker's memory limit (128MB) can cause an OOM. When set, throws
	 * before sending if the fully-read body exceeds this byte count.
	 */
	maxBytes?: number;
	/**
	 * Timeout (in milliseconds) for get/put/delete requests. No timeout if
	 * omitted (the previous behavior). Cloudflare Workers' `fetch` has no
	 * default timeout, so setting this is recommended in production.
	 */
	timeoutMs?: number;
};

/**
 * `encodeURIComponent`s each path segment of an S3-compatible API object key
 * (leaving `/` itself as the separator). `..` segments pass through
 * `encodeURIComponent` unchanged and could escape the bucket prefix via
 * `new URL()` or aws4fetch's dot-segment normalization, so they are
 * explicitly rejected.
 *
 * The S3-compatible adapters (`S3Storage`/`S3UrlSigner`) share this policy,
 * and `GcsUrlSigner` reuses it too (its path-style signed URLs need the same
 * per-segment encoding and `..` rejection). `GoogleCloudStorage`'s put/get/
 * delete apply a single `encodeURIComponent` to the whole key instead, so
 * `..` segment traversal cannot occur there and this function is not used
 * for those operations (behavior is unchanged).
 */
export const encodeS3Key = (key: string): string => {
	const segments = key.split("/");
	if (segments.some((segment) => segment === "..")) {
		throw new Error(`key must not contain "..": ${key}`);
	}
	return segments.map((segment) => encodeURIComponent(segment)).join("/");
};

/**
 * Threshold above which `put` switches to a Multipart Upload; also the size
 * of each part once switched (mirrors `R2Storage`'s `MULTIPART_PART_SIZE_BYTES`
 * convention: 100 MiB fits within S3's part-size bounds of 5 MiB-5 GiB).
 */
const MULTIPART_PART_SIZE_BYTES = 100 * 1024 * 1024;

/** A completed part collected during a Multipart Upload, used to build the `CompleteMultipartUpload` XML body. */
type CompletedPart = { partNumber: number; eTag: string };

/** `Storage` backend for S3-compatible object storage APIs. */
export class S3Storage extends Storage {
	private readonly client: AwsClient;
	private readonly endpoint: string;
	private readonly bucket: string;
	private readonly fetch: typeof fetch;
	private readonly maxBytes: number | undefined;
	private readonly timeoutMs: number | undefined;

	constructor(config: S3StorageConfig) {
		super();
		this.client = new AwsClient({
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
			region: config.region,
		});
		this.endpoint = config.endpoint;
		this.bucket = config.bucket;
		this.fetch = config.fetch ?? fetch;
		this.maxBytes = config.maxBytes;
		this.timeoutMs = config.timeoutMs;
	}

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		const body = data instanceof ReadableStream ? await S3Storage.readAll(data) : data;
		const size = await S3Storage.byteLength(body);
		if (this.maxBytes !== undefined && size > this.maxBytes) {
			throw new Error(`Upload size exceeds the limit (${this.maxBytes} bytes)`);
		}

		if (size > MULTIPART_PART_SIZE_BYTES) {
			await this.putMultipart(key, body, size, contentType);
			return;
		}

		const request = await this.client.sign(this.objectUrl(key), {
			method: "PUT",
			headers: { "Content-Type": contentType },
			body,
		});

		const response = await this.fetch(request, this.timeoutInit());
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`S3 PUT Object failed (${response.status}): ${text}`);
		}
	}

	async get(key: string): Promise<StorageObject | null> {
		const request = await this.client.sign(this.objectUrl(key), { method: "GET" });
		const response = await this.fetch(request, this.timeoutInit());

		if (response.status === 404) return null;
		if (!response.ok || !response.body) {
			const text = await response.text();
			throw new Error(`S3 GET Object failed (${response.status}): ${text}`);
		}

		return { body: response.body, contentType: response.headers.get("content-type") };
	}

	async delete(key: string): Promise<void> {
		const request = await this.client.sign(this.objectUrl(key), { method: "DELETE" });
		const response = await this.fetch(request, this.timeoutInit());

		if (!response.ok && response.status !== 404) {
			const text = await response.text();
			throw new Error(`S3 DELETE Object failed (${response.status}): ${text}`);
		}
	}

	/**
	 * Uploads a body larger than `MULTIPART_PART_SIZE_BYTES` via S3's
	 * Multipart Upload API: create, then upload fixed-size parts in order,
	 * then complete. Aborts the upload and rethrows on any failure after
	 * creation (the abort itself is best-effort; its own failure never masks
	 * the original error).
	 */
	private async putMultipart(
		key: string,
		body: Blob | ArrayBuffer,
		size: number,
		contentType: string,
	): Promise<void> {
		const uploadId = await this.createMultipartUpload(key, contentType);
		try {
			const parts: CompletedPart[] = [];
			let partNumber = 1;
			for (let offset = 0; offset < size; offset += MULTIPART_PART_SIZE_BYTES) {
				const end = Math.min(offset + MULTIPART_PART_SIZE_BYTES, size);
				const slice = body instanceof Blob ? body.slice(offset, end) : body.slice(offset, end);
				parts.push({ partNumber, eTag: await this.uploadPart(key, uploadId, partNumber, slice) });
				partNumber += 1;
			}
			await this.completeMultipartUpload(key, uploadId, parts);
		} catch (error) {
			try {
				await this.abortMultipartUpload(key, uploadId);
			} catch {
				// Best-effort cleanup; the original error below always wins.
			}
			throw error;
		}
	}

	/** `POST <objectUrl>?uploads` — initiates a Multipart Upload and returns its `UploadId`. */
	private async createMultipartUpload(key: string, contentType: string): Promise<string> {
		const url = new URL(this.objectUrl(key));
		url.searchParams.set("uploads", "");

		const request = await this.client.sign(url, {
			method: "POST",
			headers: { "Content-Type": contentType },
		});
		const response = await this.fetch(request, this.timeoutInit());
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`S3 CreateMultipartUpload failed (${response.status}): ${text}`);
		}

		const match = text.match(/<UploadId>([^<]+)<\/UploadId>/);
		if (!match) {
			throw new Error(`S3 CreateMultipartUpload response is missing an UploadId: ${text}`);
		}
		return match[1];
	}

	/** `PUT <objectUrl>?partNumber=<n>&uploadId=<id>` — uploads one part and returns its `ETag`. */
	private async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: Blob | ArrayBuffer,
	): Promise<string> {
		const url = new URL(this.objectUrl(key));
		url.searchParams.set("partNumber", String(partNumber));
		url.searchParams.set("uploadId", uploadId);

		const request = await this.client.sign(url, { method: "PUT", body });
		const response = await this.fetch(request, this.timeoutInit());
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`S3 UploadPart failed (${response.status}): ${text}`);
		}

		const eTag = response.headers.get("etag");
		if (!eTag) {
			throw new Error(`S3 UploadPart response is missing an ETag (part ${partNumber})`);
		}
		return eTag;
	}

	/** `POST <objectUrl>?uploadId=<id>` — completes the Multipart Upload with the list of uploaded parts. */
	private async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: CompletedPart[],
	): Promise<void> {
		const url = new URL(this.objectUrl(key));
		url.searchParams.set("uploadId", uploadId);

		const request = await this.client.sign(url, {
			method: "POST",
			headers: { "Content-Type": "application/xml" },
			body: S3Storage.completeMultipartUploadXml(parts),
		});
		const response = await this.fetch(request, this.timeoutInit());
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`S3 CompleteMultipartUpload failed (${response.status}): ${text}`);
		}
	}

	/** `DELETE <objectUrl>?uploadId=<id>` — aborts the Multipart Upload. */
	private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		const url = new URL(this.objectUrl(key));
		url.searchParams.set("uploadId", uploadId);

		const request = await this.client.sign(url, { method: "DELETE" });
		await this.fetch(request, this.timeoutInit());
	}

	/** Builds the `<CompleteMultipartUpload>` XML body, preserving `parts`' order (ascending `partNumber`, as required by S3). */
	private static completeMultipartUploadXml(parts: CompletedPart[]): string {
		const items = parts
			.map(
				(part) =>
					`<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`,
			)
			.join("");
		return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${items}</CompleteMultipartUpload>`;
	}

	/** Returns a `RequestInit` containing `signal` only when `timeoutMs` is set (merged into the signed `Request` via the second argument). */
	private timeoutInit(): RequestInit | undefined {
		const signal = timeoutSignal(this.timeoutMs);
		return signal ? { signal } : undefined;
	}

	/** Encodes `key` per path segment (leaving `/` as the separator). */
	private objectUrl(key: string): string {
		return `${this.endpoint}/${this.bucket}/${encodeS3Key(key)}`;
	}

	private static async readAll(stream: ReadableStream): Promise<ArrayBuffer> {
		return new Response(stream).arrayBuffer();
	}

	/** Returns the byte length of `put`'s body (`Blob | ArrayBuffer`). */
	private static async byteLength(body: Blob | ArrayBuffer): Promise<number> {
		return body instanceof Blob ? body.size : body.byteLength;
	}
}
