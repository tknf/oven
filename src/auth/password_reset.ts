/**
 * Password reset flow (`request` -> URL in email -> `verify`/`reset`).
 *
 * Views, route wiring, and composing the email body are the application's
 * responsibility; this class is a headless flow class
 * that only ties together "generate token -> build URL (injected by app) ->
 * send email (injected by app) -> verify -> update". Fetching and updating the
 * user are also both injected via callbacks, assuming no specific ORM (backend
 * agnosticism).
 *
 * By using a fragment of the current password hash etc. as the `DataToken`
 * fingerprint, an already-issued but unused token is automatically invalidated
 * once the reset completes (the password changes) (see `data_token.ts`).
 *
 * `request` does not throw even when the target email does not exist, and
 * returns the same `void` (enumeration prevention). However, since whether
 * `deliver` is called can still cause a difference in response time, it is
 * recommended to enqueue email sending to a background job such as
 * `DeliverMailJob` so the handler's own response always returns at the same
 * timing.
 */
import { DataToken } from "./data_token.js";
import { hashPassword } from "./password.js";

export type PasswordResetOptions<TUser> = {
	/** List of signing secrets. At least one is required. Signing uses the first entry; verification uses all entries (passed through to DataToken as-is). */
	secrets: string[];
	/** Token validity period in seconds. Default 900 (15 minutes). */
	expiresInSeconds?: number;
	/** Purpose identifier for the token. Default "oven:password_reset". */
	purpose?: string;
	/** Finds a user by email. `null` if not found. */
	findByEmail: (email: string) => TUser | null | undefined | Promise<TUser | null | undefined>;
	/** Resolves a user from an identifier (the same vocabulary as Guard's provider). */
	provider: (identity: string) => TUser | null | undefined | Promise<TUser | null | undefined>;
	/** Extracts the identifier (the string embedded in the token) from a user. */
	identityOf: (user: TUser) => string;
	/** Extracts the fingerprint (e.g. a trailing fragment of the password hash) from a user. */
	fingerprintOf: (user: TUser) => string;
	/** Builds the reset URL (the full URL placed in the email) from a token. */
	resetUrl: (token: string) => string;
	/** Sends the reset email. Enqueueing to a DeliverMailJob etc. also happens here. */
	deliver: (user: TUser, url: string) => void | Promise<void>;
	/** Updates the user with the new password hash. */
	updatePassword: (user: TUser, passwordHash: string) => void | Promise<void>;
	/** The password hashing function. Defaults to hashPassword (password.ts). */
	hash?: (password: string) => Promise<string>;
};

const DEFAULT_PURPOSE = "oven:password_reset";
const DEFAULT_EXPIRES_IN_SECONDS = 900;

/**
 * Runs the password reset flow. `request`/`verify`/`reset` are declared as
 * arrow-function class fields because they may be passed by reference from
 * handlers.
 */
export class PasswordReset<TUser> {
	private readonly dataToken: DataToken;
	private readonly options: PasswordResetOptions<TUser>;

	constructor(options: PasswordResetOptions<TUser>) {
		this.options = options;
		this.dataToken = new DataToken({
			secrets: options.secrets,
			purpose: options.purpose ?? DEFAULT_PURPOSE,
			expiresInSeconds: options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
		});
	}

	/**
	 * Sends a reset email to `email`. If the target does not exist, does
	 * nothing and `return`s (enumeration prevention; indistinguishable from a
	 * success case by the caller).
	 */
	readonly request = async (email: string): Promise<void> => {
		const user = await this.options.findByEmail(email);
		if (!user) return;

		const token = await this.dataToken.generate(
			this.options.identityOf(user),
			this.options.fingerprintOf(user),
		);
		await this.options.deliver(user, this.options.resetUrl(token));
	};

	/** Verifies a token and, on success, returns the target user. Returns `null` on failure (malformed, expired, or already invalidated). */
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
	 * Verifies a token and, on success, updates the user with the hash of
	 * `password` and returns them. Returns `null` on failure.
	 */
	readonly reset = async (token: string, password: string): Promise<TUser | null> => {
		const user = await this.verify(token);
		if (!user) return null;

		const hash = this.options.hash ?? hashPassword;
		const passwordHash = await hash(password);
		await this.options.updatePassword(user, passwordHash);
		return user;
	};
}
