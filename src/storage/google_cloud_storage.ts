/**
 * `Storage` implementation that talks to the Google Cloud Storage JSON API
 * (`storage.googleapis.com`) using plain `fetch`.
 *
 * Authentication is handled by a `tokenProvider` passed to the constructor
 * that returns an OAuth2 access token. How the token is obtained (signing a
 * service account key, the metadata server, etc.) is the application's
 * responsibility; this class does not deal with key management or JWT
 * signing at all.
 *
 * A `ReadableStream`, or a `Blob`/`ArrayBuffer` at or below
 * `RESUMABLE_THRESHOLD_BYTES` (100 MiB, mirroring the R2 adapter's threshold
 * convention), goes through GCS's simple `uploadType=media` upload as
 * before, streamed through to `fetch` unbuffered. A `Blob`/`ArrayBuffer`
 * above that threshold switches to GCS's resumable upload protocol
 * (initiate, then PUT fixed-size chunks to the returned session URI) instead
 * — unlike `S3Storage`'s multipart upload, this only applies to bodies with
 * a size known up front; a `ReadableStream` always takes the simple-upload
 * path regardless of size (this is a deliberate per-backend difference, see
 * docs/storage-kv.md).
 */
import { Storage, type StorageObject } from "./storage.js";

export type GoogleCloudStorageConfig = {
	bucket: string;
	/** Returns a valid OAuth2 access token on each call. Caching and refreshing are the application's responsibility. */
	tokenProvider: () => Promise<string>;
	/** For test injection. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
};

/**
 * Threshold above which `put` switches from a simple `uploadType=media`
 * upload to GCS's resumable upload protocol (mirrors `R2Storage`'s
 * `MULTIPART_PART_SIZE_BYTES` convention: 100 MiB, also used as the
 * resumable chunk size, is a multiple of the 256 KiB chunk-size granularity
 * GCS requires for all but the final chunk).
 */
const RESUMABLE_THRESHOLD_BYTES = 100 * 1024 * 1024;

/** `Storage` backend for Google Cloud Storage buckets. */
export class GoogleCloudStorage extends Storage {
	private readonly bucket: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetch: typeof fetch;

	constructor(config: GoogleCloudStorageConfig) {
		super();
		this.bucket = config.bucket;
		this.tokenProvider = config.tokenProvider;
		this.fetch = config.fetch ?? fetch;
	}

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		if (!(data instanceof ReadableStream)) {
			const size = data instanceof Blob ? data.size : data.byteLength;
			if (size > RESUMABLE_THRESHOLD_BYTES) {
				await this.putResumable(key, data, size, contentType);
				return;
			}
		}

		const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
		const response = await this.fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${await this.tokenProvider()}`,
				"Content-Type": contentType,
			},
			body: data,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to upload GCS object (${response.status}): ${text}`);
		}
	}

	async get(key: string): Promise<StorageObject | null> {
		const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}?alt=media`;
		const response = await this.fetch(url, {
			headers: { Authorization: `Bearer ${await this.tokenProvider()}` },
		});

		if (response.status === 404) return null;
		if (!response.ok || !response.body) {
			const text = await response.text();
			throw new Error(`Failed to fetch GCS object (${response.status}): ${text}`);
		}

		return { body: response.body, contentType: response.headers.get("content-type") };
	}

	async delete(key: string): Promise<void> {
		const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(key)}`;
		const response = await this.fetch(url, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${await this.tokenProvider()}` },
		});

		if (!response.ok && response.status !== 404) {
			const text = await response.text();
			throw new Error(`Failed to delete GCS object (${response.status}): ${text}`);
		}
	}

	/**
	 * Uploads a `Blob`/`ArrayBuffer` larger than `RESUMABLE_THRESHOLD_BYTES`
	 * via GCS's resumable upload protocol: initiate a session, then PUT
	 * fixed-size chunks (the final chunk may be smaller) to the returned
	 * session URI. Per Google's documented protocol, chunk PUT requests carry
	 * no `Authorization` header — the session URI itself is bound to the
	 * token that created it.
	 */
	private async putResumable(
		key: string,
		data: Blob | ArrayBuffer,
		size: number,
		contentType: string,
	): Promise<void> {
		const sessionUri = await this.initiateResumableUpload(key, size, contentType);

		for (let offset = 0; offset < size; offset += RESUMABLE_THRESHOLD_BYTES) {
			const end = Math.min(offset + RESUMABLE_THRESHOLD_BYTES, size);
			const chunk = data instanceof Blob ? data.slice(offset, end) : data.slice(offset, end);
			const isFinalChunk = end === size;

			const response = await this.fetch(sessionUri, {
				method: "PUT",
				headers: {
					"Content-Length": String(end - offset),
					"Content-Range": `bytes ${offset}-${end - 1}/${size}`,
				},
				body: chunk,
			});

			if (isFinalChunk) {
				if (!response.ok) {
					const text = await response.text();
					throw new Error(`GCS resumable upload failed to complete (${response.status}): ${text}`);
				}
			} else if (response.status !== 308) {
				const text = await response.text();
				throw new Error(`GCS resumable upload chunk failed (${response.status}): ${text}`);
			}
		}
	}

	/** `POST .../o?uploadType=resumable&name=<key>` — starts a resumable session and returns its session URI (the response's `Location` header). */
	private async initiateResumableUpload(
		key: string,
		size: number,
		contentType: string,
	): Promise<string> {
		const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=resumable&name=${encodeURIComponent(key)}`;
		const response = await this.fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${await this.tokenProvider()}`,
				"X-Upload-Content-Type": contentType,
				"X-Upload-Content-Length": String(size),
			},
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`Failed to initiate GCS resumable upload (${response.status}): ${text}`);
		}

		const sessionUri = response.headers.get("location");
		if (!sessionUri) {
			throw new Error("GCS resumable upload response is missing a Location header");
		}
		return sessionUri;
	}
}
