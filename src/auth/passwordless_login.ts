/**
 * Passwordless (magic-link) login flow (`request` -> URL in email -> `login`).
 *
 * Views, route wiring, and composing the email body are the application's
 * responsibility; this class is a headless flow class that only ties together
 * "generate token -> build URL (injected by app) -> send email (injected by
 * app) -> verify -> log in". Establishing the session on success is also the
 * application's responsibility (call `SessionAccessor`/`Session#set` with the
 * user this class returns) — this class never touches `Session` itself.
 *
 * A login-granting link must be genuinely single-use: anyone who observes the
 * URL (mail forwarding, a shared machine, a proxy log) must not be able to
 * replay it. `DataToken` alone does not provide that — it is stateless, so a
 * token stays valid, and replayable, for its whole TTL unless its fingerprint
 * changes. `EmailVerification` accepts that tradeoff because its fingerprint
 * is the email address, which `confirm` never changes, so its token stays
 * replayable until expiry (fine for idempotent email confirmation, but not
 * acceptable for granting a login). `PasswordReset` gets genuine single-use
 * "for free" because completing it changes the password hash it fingerprints.
 *
 * `PasswordlessLogin` reproduces `PasswordReset`'s mechanism deliberately: the
 * fingerprint is a per-user rotating nonce (`fingerprintOf`), and `login`
 * calls `rotateNonce` on success to change it, which invalidates the
 * just-used token and any other outstanding link for that user. This is the
 * one option the two sibling flows don't need — wiring it correctly (see
 * below) is what makes the login link single-use.
 *
 * Gotcha: if `fingerprintOf` and `rotateNonce` aren't wired to the same
 * mutable value on `TUser` (or `rotateNonce` is skipped, e.g. by calling
 * `verify` instead of `login` to complete the flow), the link degrades to
 * plain replay-until-expiry, exactly like `EmailVerification`. Keep
 * `expiresInSeconds` short regardless, since it is the only backstop left if
 * rotation is ever misconfigured.
 */
import { DataToken } from "./data_token.js";

export type PasswordlessLoginOptions<TUser> = {
	/** List of signing secrets. At least one is required. Signing uses the first entry; verification uses all entries (passed through to DataToken as-is). */
	secrets: string[];
	/** Token validity period in seconds. Default 900 (15 minutes). */
	expiresInSeconds?: number;
	/** Purpose identifier for the token. Default "oven:passwordless_login". */
	purpose?: string;
	/** Finds a user by email. `null` if not found. */
	findByEmail: (email: string) => TUser | null | undefined | Promise<TUser | null | undefined>;
	/** Resolves a user from an identifier (the same vocabulary as Guard's provider). */
	provider: (identity: string) => TUser | null | undefined | Promise<TUser | null | undefined>;
	/** Extracts the identifier (the string embedded in the token) from a user. */
	identityOf: (user: TUser) => string;
	/**
	 * Extracts the fingerprint from a user: the user's current login nonce.
	 * This MUST be a value that `rotateNonce` changes — that binding between
	 * `fingerprintOf` and `rotateNonce` is what makes an issued link single-use
	 * (see the module JSDoc).
	 */
	fingerprintOf: (user: TUser) => string;
	/** Builds the login URL (the full URL placed in the email) from a token. */
	loginUrl: (token: string) => string;
	/** Sends the login email. Enqueueing to a DeliverMailJob etc. also happens here. */
	deliver: (user: TUser, url: string) => void | Promise<void>;
	/**
	 * Rotates the user's login nonce, i.e. changes the value `fingerprintOf`
	 * returns. Called by `login` on success. The application should set a
	 * fresh random value (e.g. via `crypto.getRandomValues`) and persist it —
	 * this invalidates the token that was just used, and any other
	 * still-outstanding login link for the same user, since their fingerprint
	 * no longer matches.
	 */
	rotateNonce: (user: TUser) => void | Promise<void>;
};

const DEFAULT_PURPOSE = "oven:passwordless_login";
const DEFAULT_EXPIRES_IN_SECONDS = 900;

/**
 * Runs the passwordless (magic-link) login flow. `request`/`verify`/`login`
 * are declared as arrow-function class fields because they may be passed by
 * reference from handlers.
 */
export class PasswordlessLogin<TUser> {
	private readonly dataToken: DataToken;
	private readonly options: PasswordlessLoginOptions<TUser>;

	constructor(options: PasswordlessLoginOptions<TUser>) {
		this.options = options;
		this.dataToken = new DataToken({
			secrets: options.secrets,
			purpose: options.purpose ?? DEFAULT_PURPOSE,
			expiresInSeconds: options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
		});
	}

	/**
	 * Sends a login email to `email`. If the target does not exist, does
	 * nothing and `return`s (enumeration prevention; indistinguishable from a
	 * success case by the caller). Since whether `deliver` is called can still
	 * cause a difference in response time, it is recommended to enqueue email
	 * sending to a background job such as `DeliverMailJob` so the handler's own
	 * response always returns at the same timing.
	 */
	readonly request = async (email: string): Promise<void> => {
		const user = await this.options.findByEmail(email);
		if (!user) return;

		const token = await this.dataToken.generate(
			this.options.identityOf(user),
			this.options.fingerprintOf(user),
		);
		await this.options.deliver(user, this.options.loginUrl(token));
	};

	/**
	 * Verifies a token and, on success, returns the target user. Does not call
	 * `rotateNonce`, so this can also be used for a display/pre-check step
	 * without invalidating the link. Returns `null` on failure (malformed,
	 * expired, or already invalidated).
	 */
	readonly verify = async (token: string): Promise<TUser | null> => {
		let resolvedUser: TUser | null = null;

		const identity = await this.dataToken.verify(token, async (identity) => {
			const user = await this.options.provider(identity);
			if (!user) return null;

			resolvedUser = user;
			return this.options.fingerprintOf(user);
		});

		return identity === null ? null : resolvedUser;
	};

	/**
	 * Verifies a token and, on success, rotates the user's login nonce (so the
	 * token — and any other outstanding link for that user — can never be used
	 * again) and returns the user. Returns `null` on failure. Establishing the
	 * session is the caller's responsibility: it should take the returned user
	 * and call its own `SessionAccessor`/`Session#set`.
	 */
	readonly login = async (token: string): Promise<TUser | null> => {
		const user = await this.verify(token);
		if (!user) return null;

		await this.options.rotateNonce(user);
		return user;
	};
}
