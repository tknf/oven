/**
 * `Storage` implementation backed by an S3-compatible API (AWS S3, R2, MinIO,
 * GCS interop, etc.). Signing is done via `aws4fetch`'s `AwsClient`
 * (Workers-compatible and lightweight).
 *
 * Because `aws4fetch` needs the request body to compute the SigV4 signature,
 * a `ReadableStream` passed to `put` is read fully into an `ArrayBuffer`
 * before being sent (streaming upload is not supported). Handling very large
 * objects would require a separate Multipart Upload implementation, which is
 * not implemented here. The maximum number of bytes read can be capped via
 * `S3StorageConfig#maxBytes`; set this to avoid OOM under a Worker's memory
 * limit.
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
 * Both S3-compatible adapters (`S3Storage`/`S3UrlSigner`) share this policy.
 * GCS (`GoogleCloudStorage`) applies a single `encodeURIComponent` to the
 * whole key, so `..` segment traversal cannot occur there and this function
 * is not used for it (behavior is unchanged).
 */
export const encodeS3Key = (key: string): string => {
	const segments = key.split("/");
	if (segments.some((segment) => segment === "..")) {
		throw new Error(`key must not contain "..": ${key}`);
	}
	return segments.map((segment) => encodeURIComponent(segment)).join("/");
};

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
		if (this.maxBytes !== undefined && (await S3Storage.byteLength(body)) > this.maxBytes) {
			throw new Error(`Upload size exceeds the limit (${this.maxBytes} bytes)`);
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
