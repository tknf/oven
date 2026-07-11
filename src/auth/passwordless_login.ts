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
 * Concurrency: `rotateNonce` is a compare-and-swap, not a blind write — it
 * only rotates (and returns `true`) when the stored nonce still equals the
 * one `verify` matched, and returns `false` otherwise. That is what keeps
 * the single-use guarantee genuine when two requests race to redeem the same
 * token (e.g. mail-client link prefetching, or a user double-clicking):
 * both may pass `verify` before either rotates, but only one `rotateNonce`
 * call can win the CAS, so `login` returns the user to exactly one caller
 * and `null` to the other. A blind unconditional write would let both
 * callers "win" and establish two sessions from one single-use link. See
 * `PasswordlessLoginOptions.rotateNonce`'s JSDoc for the required
 * implementation shape.
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
	 * Atomically rotates the user's login nonce, i.e. changes the value
	 * `fingerprintOf` returns, but ONLY IF the currently stored nonce still
	 * equals `expectedNonce` (the fingerprint `login` verified the token
	 * against). Called by `login` on success.
	 *
	 * This MUST be a single conditional/atomic write, e.g.:
	 * `UPDATE users SET login_nonce = <fresh> WHERE id = ? AND login_nonce = ?`,
	 * returning `true` iff `affectedRows > 0` (or, with Drizzle,
	 * `.update(...).where(and(eq(id, ...), eq(loginNonce, expectedNonce))).returning()`
	 * and checking the result length) — NOT a read-then-write, and not a
	 * blind unconditional write. Two concurrent `login` calls for the SAME
	 * token both pass `verify` before either rotates (the nonce hasn't
	 * changed yet), so a blind write would let both callers "win" and
	 * establish a session from what was supposed to be a single-use link;
	 * the compare-and-swap is what guarantees only one of them can.
	 *
	 * Set the fresh value to something unpredictable (e.g. via
	 * `crypto.getRandomValues`) and persist it — this invalidates the token
	 * that was just used, and any other still-outstanding login link for the
	 * same user, since their fingerprint no longer matches.
	 *
	 * Returns `true` iff this call changed the row (this login wins and may
	 * proceed), `false` otherwise (another concurrent login already consumed
	 * the token). Reference: `SQLiteAdminAccounts#verifyTotp` (and its
	 * MySQL/Postgres siblings, `@tknf/oven/admin`) use the same atomic
	 * conditional-UPDATE pattern for TOTP replay protection.
	 */
	rotateNonce: (user: TUser, expectedNonce: string) => boolean | Promise<boolean>;
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
	 * Shared verification core for `verify` and `login`: resolves the target
	 * user and, alongside it, the EXACT fingerprint value `dataToken.verify`
	 * checked the token's signature against. `login` needs that captured
	 * value (not a fresh call to `fingerprintOf` made afterward) as
	 * `rotateNonce`'s `expectedNonce` — re-reading `fingerprintOf(user)` after
	 * this method returns could already observe a concurrent `login` call's
	 * rotation, which would silently turn the compare-and-swap into a no-op
	 * (see the module JSDoc's "Concurrency" note). Returns `null` on failure
	 * (malformed, expired, or already invalidated).
	 */
	private readonly verifyWithFingerprint = async (
		token: string,
	): Promise<{ user: TUser; fingerprint: string } | null> => {
		let resolved: { user: TUser; fingerprint: string } | null = null;

		const identity = await this.dataToken.verify(token, async (identity) => {
			const user = await this.options.provider(identity);
			if (!user) return null;

			const fingerprint = this.options.fingerprintOf(user);
			resolved = { user, fingerprint };
			return fingerprint;
		});

		return identity === null ? null : resolved;
	};

	/**
	 * Verifies a token and, on success, returns the target user. Does not call
	 * `rotateNonce`, so this can also be used for a display/pre-check step
	 * without invalidating the link. Returns `null` on failure (malformed,
	 * expired, or already invalidated).
	 */
	readonly verify = async (token: string): Promise<TUser | null> => {
		const result = await this.verifyWithFingerprint(token);
		return result ? result.user : null;
	};

	/**
	 * Verifies a token and, on success, atomically consumes the user's login
	 * nonce via `rotateNonce` (so the token — and any other outstanding link
	 * for that user — can never be used again) and returns the user. Returns
	 * `null` when the token itself does not verify, OR when `rotateNonce`
	 * reports it lost the compare-and-swap race to a concurrent `login` call
	 * for the same token (see `rotateNonce`'s JSDoc and the module JSDoc's
	 * "Concurrency" note). Establishing the session is the caller's
	 * responsibility: it should take the returned user and call its own
	 * `SessionAccessor`/`Session#set`.
	 */
	readonly login = async (token: string): Promise<TUser | null> => {
		const result = await this.verifyWithFingerprint(token);
		if (!result) return null;

		const consumed = await this.options.rotateNonce(result.user, result.fingerprint);
		if (!consumed) return null;

		return result.user;
	};
}
