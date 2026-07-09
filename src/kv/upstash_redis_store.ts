/**
 * `KeyValueStore` implementation that calls the Upstash Redis REST API
 * (`https://upstash.com/docs/redis/features/restapi`) with plain `fetch`.
 * Does not depend on any SDK.
 *
 * Commands are expressed as path segments (`/get/<key>`, `/set/<key>`,
 * `/del/<key>`), and since the key is treated as a path segment it is
 * encoded with `encodeURIComponent`. To avoid exceeding URL path length or
 * leaking values into error logs, `set`'s value is sent in the `POST`
 * request body rather than embedded in the path (the Upstash REST API
 * supports treating the body of `POST /set/<key>` as the command's final
 * argument). The TTL (`EX`) is specified as a query parameter. Responses
 * are always JSON in the form `{ result: ... }`.
 */
import { timeoutSignal } from "../support/fetch_timeout.js";
import { KeyValueStore } from "./key_value_store.js";

export type UpstashRedisStoreConfig = {
	/** REST URL from the Upstash console (e.g. `https://xxx.upstash.io`). */
	url: string;
	/** REST token from the Upstash console. */
	token: string;
	/** For test injection. Defaults to the global `fetch` if omitted. */
	fetch?: typeof fetch;
	/**
	 * Timeout for REST API requests, in milliseconds. No timeout if omitted
	 * (the previous behavior). Since Cloudflare Workers' `fetch` has no
	 * default timeout, specifying this is recommended for production use.
	 */
	timeoutMs?: number;
};

/** Response shape of the Upstash REST API. */
type UpstashResponse = { result: string | null };

/** `KeyValueStore` implementation backed by the Upstash Redis REST API (see module doc). */
export class UpstashRedisStore extends KeyValueStore {
	private readonly url: string;
	private readonly token: string;
	private readonly fetch: typeof fetch;
	private readonly timeoutMs: number | undefined;

	constructor(config: UpstashRedisStoreConfig) {
		super();
		this.url = config.url.replace(/\/$/, "");
		this.token = config.token;
		this.fetch = config.fetch ?? fetch;
		this.timeoutMs = config.timeoutMs;
	}

	/** Returns the value for `key`, or `null` if missing or expired. */
	async get(key: string): Promise<string | null> {
		const { result } = await this.request(["get", key]);
		return result;
	}

	/** Stores `value` under `key`, optionally with a TTL in seconds. */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		const query = ttlSeconds === undefined ? undefined : `EX=${ttlSeconds}`;
		await this.request(["set", key], { method: "POST", body: value, query });
	}

	/** Deletes `key`. Does not throw if the key does not exist. */
	async delete(key: string): Promise<void> {
		await this.request(["del", key]);
	}

	private async request(
		segments: string[],
		options: { method?: "GET" | "POST"; body?: string; query?: string } = {},
	): Promise<UpstashResponse> {
		const path = segments.map((segment) => encodeURIComponent(segment)).join("/");
		const url =
			options.query === undefined ? `${this.url}/${path}` : `${this.url}/${path}?${options.query}`;
		const response = await this.fetch(url, {
			method: options.method,
			body: options.body,
			headers: { Authorization: `Bearer ${this.token}` },
			signal: timeoutSignal(this.timeoutMs),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Upstash Redis REST API returned an error (${response.status}): ${body}`);
		}

		return response.json() as Promise<UpstashResponse>;
	}
}
