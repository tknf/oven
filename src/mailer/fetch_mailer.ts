/**
 * Abstract base for `Mailer` implementations that send via `fetch`. It knows
 * nothing about any particular mail delivery service's API shape, and leaves
 * the responsibility of building a `Request` from a `MailMessage`
 * (`buildRequest`) to subclasses. `fetch` is injected through the constructor
 * so it can be swapped out in tests, defaulting to the global `fetch` when
 * omitted.
 * To ensure header injection can't slip through even when a subclass's
 * `buildRequest` builds raw headers itself, `send` validates the `MailMessage`
 * with `assertNoMailHeaderInjection` before passing it to `buildRequest`.
 */
import { timeoutSignal } from "../support/fetch_timeout.js";
import { assertNoMailHeaderInjection, Mailer, type MailMessage } from "./mailer.js";

/** Maximum number of characters of the response body to include in an error message. */
const RESPONSE_BODY_PREVIEW_LENGTH = 500;

export abstract class FetchMailer extends Mailer {
	/**
	 * @param fetchFn Injected for testing. Defaults to the global `fetch`.
	 * @param timeoutMs Timeout (in milliseconds) for the send request. Omitting
	 *   it leaves the request untimed (as before). Since Cloudflare Workers'
	 *   `fetch` has no default timeout, specifying this is recommended in
	 *   production.
	 */
	constructor(
		private readonly fetchFn: typeof fetch = fetch,
		private readonly timeoutMs?: number,
	) {
		super();
	}

	async send(message: MailMessage): Promise<void> {
		assertNoMailHeaderInjection(message);
		const request = await this.buildRequest(message);
		const signal = timeoutSignal(this.timeoutMs);
		const response = await this.fetchFn(request, signal ? { signal } : undefined);
		if (!response.ok) {
			const body = await response.text();
			throw new Error(
				`FetchMailer: send failed (status ${response.status}): ${body.slice(0, RESPONSE_BODY_PREVIEW_LENGTH)}`,
			);
		}
	}

	/** Builds the `Request` that converts a `MailMessage` into the mail delivery service's API shape. */
	protected abstract buildRequest(message: MailMessage): Request | Promise<Request>;
}
