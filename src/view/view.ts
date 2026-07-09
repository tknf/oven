/**
 * Multi-format View that represents multiple representations of a single
 * resource (HTML/JSON/CSV/XML, etc.) in a single class. Subclasses override
 * only the format-specific methods they need, and `respond` dispatches
 * "among the implemented formats" via content negotiation based on the
 * Accept header.
 *
 * The base class only knows the four standard MIME types that are
 * Hono-independent (`text/html`, `application/json`, `text/csv`,
 * `application/xml`). Bringing a content-type specific to a particular
 * frontend technology (e.g. Turbo Streams' `text/vnd.turbo-stream.html`) into
 * the core would violate the backend/frontend-agnostic principle, so such
 * additional formats are provided as an extension point via overriding
 * `formats()` and appending to the array.
 */
import type { Context, Env } from "hono";
import { HTTPException } from "hono/http-exception";

/**
 * Extracts the acceptable media types (`type/subtype` only, excluding
 * parameters and q-values) from the `Accept` header, in order of appearance.
 * `hono/accepts`'s `accepts()` is not used here because it always falls back
 * to `default` when no content-type matches, which cannot express "truly
 * unacceptable (406)"; instead this is implemented with a simple parse
 * (strict q-value priority calculation is not needed, since presence checking
 * is sufficient).
 */
const parseAcceptedTypes = (header: string): string[] =>
	header
		.split(",")
		.map((part) => part.split(";")[0]?.trim())
		.filter((type): type is string => Boolean(type));

/**
 * Definition of a single format returned by `formats()`. `contentTypes` are
 * the Accept negotiation candidates, and `handler` generates the actual response.
 */
export type ViewFormat<E extends Env> = {
	name: string;
	contentTypes: string[];
	handler: (c: Context<E>) => Response | Promise<Response>;
};

export abstract class View<E extends Env = Env> {
	/** Builds the HTML representation. The base implementation throws a not-implemented error. */
	html(_c: Context<E>): Response | Promise<Response> {
		throw new Error("This view does not implement html");
	}

	/** Builds the JSON representation. The base implementation throws a not-implemented error. */
	json(_c: Context<E>): Response | Promise<Response> {
		throw new Error("This view does not implement json");
	}

	/** Builds the CSV representation. The base implementation throws a not-implemented error. */
	csv(_c: Context<E>): Response | Promise<Response> {
		throw new Error("This view does not implement csv");
	}

	/** Builds the XML representation. The base implementation throws a not-implemented error. */
	xml(_c: Context<E>): Response | Promise<Response> {
		throw new Error("This view does not implement xml");
	}

	/**
	 * Returns the list of formats this view can respond with, in negotiation
	 * priority order. The default implementation returns only the ones the
	 * subclass actually overrode, out of the base four formats (in the order
	 * `html` -> `json` -> `csv` -> `xml`); override detection is done by
	 * comparing against `View.prototype`.
	 *
	 * To add a content-type specific to a particular frontend technology
	 * (e.g. `text/vnd.turbo-stream.html`), override this method and append to
	 * the array. The array's order becomes the negotiation priority order.
	 */
	protected formats(): ViewFormat<E>[] {
		const candidates: (ViewFormat<E> & { isOverridden: boolean })[] = [
			{
				name: "html",
				contentTypes: ["text/html"],
				handler: (c) => this.html(c),
				isOverridden: this.html !== View.prototype.html,
			},
			{
				name: "json",
				contentTypes: ["application/json"],
				handler: (c) => this.json(c),
				isOverridden: this.json !== View.prototype.json,
			},
			{
				name: "csv",
				contentTypes: ["text/csv"],
				handler: (c) => this.csv(c),
				isOverridden: this.csv !== View.prototype.csv,
			},
			{
				name: "xml",
				contentTypes: ["application/xml"],
				handler: (c) => this.xml(c),
				isOverridden: this.xml !== View.prototype.xml,
			},
		];

		return candidates
			.filter((candidate) => candidate.isOverridden)
			.map(({ name, contentTypes, handler }) => ({ name, contentTypes, handler }));
	}

	/**
	 * Dispatches to one of the formats returned by `formats()` via content
	 * negotiation based on the Accept header. If the Accept header is absent
	 * or contains a wildcard (accepts any type), uses the first entry of
	 * `formats()` (the first in default order). Otherwise, in the order of
	 * `formats()` (= priority order), picks the first format whose
	 * content-type is accepted by the Accept header. If no candidate is
	 * acceptable, throws 406 via `HTTPException`.
	 */
	readonly respond = async (c: Context<E>): Promise<Response> => {
		const formats = this.formats();
		if (formats.length === 0) {
			throw new HTTPException(406, { message: "This resource has no representable format" });
		}

		const acceptHeader = c.req.header("Accept");
		if (!acceptHeader) {
			const first = formats[0];
			if (!first)
				throw new HTTPException(406, { message: "This resource has no representable format" });
			return first.handler(c);
		}

		const acceptedTypes = parseAcceptedTypes(acceptHeader);
		if (acceptedTypes.includes("*/*")) {
			const first = formats[0];
			if (!first)
				throw new HTTPException(406, { message: "This resource has no representable format" });
			return first.handler(c);
		}

		const format = formats.find((candidate) =>
			candidate.contentTypes.some((contentType) => acceptedTypes.includes(contentType)),
		);
		if (!format) {
			throw new HTTPException(406, { message: "The requested representation is not supported" });
		}

		return format.handler(c);
	};
}
