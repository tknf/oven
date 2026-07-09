/**
 * `Storage` implementation that talks to the Google Cloud Storage JSON API
 * (`storage.googleapis.com`) using plain `fetch`.
 *
 * Authentication is handled by a `tokenProvider` passed to the constructor
 * that returns an OAuth2 access token. How the token is obtained (signing a
 * service account key, the metadata server, etc.) is the application's
 * responsibility; this class does not deal with key management or JWT
 * signing at all.
 */
import { Storage, type StorageObject } from "./storage.js";

export type GoogleCloudStorageConfig = {
	bucket: string;
	/** Returns a valid OAuth2 access token on each call. Caching and refreshing are the application's responsibility. */
	tokenProvider: () => Promise<string>;
	/** For test injection. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
};

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
}
