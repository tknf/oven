/**
 * Concrete convention on top of `Datasource` for a single REST resource
 * (e.g. `/users`), giving it the same `retrieve`/`list`/`create`/`update`/
 * `delete` vocabulary as `Model`. `retrieve` mirrors `Model#retrieve` by
 * returning `undefined` instead of throwing when the resource responds
 * `404`, since "not found" is an expected outcome for a lookup by id, not
 * an exceptional one.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DatasourceQuery } from "./datasource.js";
import { Datasource } from "./datasource.js";
import { DatasourceError } from "./datasource_error.js";

export type RestRequestOptions = {
	query?: DatasourceQuery;
	headers?: HeadersInit;
};

export abstract class RestDatasource<T> extends Datasource {
	/** Resource path appended to `baseUrl`, e.g. `"/users"`. */
	protected abstract get resourcePath(): string;

	/** Standard Schema validating a single entity of this resource. */
	protected abstract get schema(): StandardSchemaV1<unknown, T>;

	/** Fetches a single entity by id. Returns `undefined` if the resource responds `404`. */
	async retrieve(id: string | number, options: RestRequestOptions = {}): Promise<T | undefined> {
		try {
			return await this.request(this.entityPath(id), {
				method: "GET",
				query: options.query,
				headers: options.headers,
				schema: this.schema,
			});
		} catch (err) {
			if (err instanceof DatasourceError && err.status === 404) return undefined;
			throw err;
		}
	}

	/**
	 * Fetches every entity of this resource. The raw response is unwrapped
	 * into an array via `toArray` (overridable for an enveloped list such as
	 * `{ data: [...] }`), and each item is validated individually against
	 * `schema`.
	 */
	async list(options: RestRequestOptions = {}): Promise<T[]> {
		const raw = await this.request(this.resourcePath, {
			method: "GET",
			query: options.query,
			headers: options.headers,
		});
		const items = this.toArray(raw);
		return Promise.all(items.map((item) => this.validate(this.schema, item)));
	}

	/** Creates a new entity. */
	async create(body: unknown, options: RestRequestOptions = {}): Promise<T> {
		return this.request(this.resourcePath, {
			method: "POST",
			query: options.query,
			headers: options.headers,
			body,
			schema: this.schema,
		});
	}

	/** Updates an existing entity by id. */
	async update(id: string | number, body: unknown, options: RestRequestOptions = {}): Promise<T> {
		return this.request(this.entityPath(id), {
			method: "PATCH",
			query: options.query,
			headers: options.headers,
			body,
			schema: this.schema,
		});
	}

	/** Deletes an entity by id. */
	async delete(id: string | number, options: RestRequestOptions = {}): Promise<void> {
		await this.request(this.entityPath(id), {
			method: "DELETE",
			query: options.query,
			headers: options.headers,
		});
	}

	/**
	 * Unwraps the raw `list` response into an array of unvalidated entities.
	 * Defaults to requiring the response itself to be a JSON array; override
	 * this to unwrap an enveloped list (e.g. `{ data: [...] }`).
	 */
	protected toArray(raw: unknown): unknown[] {
		if (Array.isArray(raw)) return raw;
		throw new Error(
			"RestDatasource#list expected a JSON array response. Override toArray() to unwrap an enveloped list (e.g. { data: [...] }).",
		);
	}

	/** Path of a single entity within this resource, e.g. `/users/42`. */
	private entityPath(id: string | number): string {
		// Drop a trailing slash on resourcePath so it can't produce a double slash here.
		const resourcePath = this.resourcePath.replace(/\/$/, "");
		return `${resourcePath}/${encodeURIComponent(String(id))}`;
	}
}
