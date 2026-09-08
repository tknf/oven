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
 * Concurrent use is rejected by the required atomic `updatePassword` callback,
 * which compares the stored fingerprint with the exact value verified here.
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
	/**
	 * Extracts the current fingerprint, preferably the full stored password hash.
	 * A successful `updatePassword` MUST change this value to invalidate old tokens.
	 */
	fingerprintOf: (user: TUser) => string;
	/** Builds the reset URL (the full URL placed in the email) from a token. */
	resetUrl: (token: string) => string;
	/** Sends the reset email. Enqueueing to a DeliverMailJob etc. also happens here. */
	deliver: (user: TUser, url: string) => void | Promise<void>;
	/**
	 * Atomically writes `passwordHash` ONLY IF the stored fingerprint still equals
	 * `expectedFingerprint`, the exact value used to verify the token. Return true
	 * only when this call updated the row; return false when it no longer matches
	 * or the user was removed. A false result makes `reset` return null.
	 *
	 * Use one conditional database update (compare-and-swap), not a separate read
	 * and write or a process-local lock. With a full password-hash fingerprint:
	 * `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`.
	 * Check affected rows (or returned rows) and never return true unconditionally.
	 * A custom hash function must produce a fresh hash on every successful reset.
	 */
	updatePassword: (
		user: TUser,
		passwordHash: string,
		expectedFingerprint: string,
	) => boolean | Promise<boolean>;
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

	/** Captures the exact verified fingerprint before asynchronous hashing or a concurrent update. */
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

	/** Checks a token for display purposes without consuming it. Use `reset` to change the password. */
	readonly verify = async (token: string): Promise<TUser | null> => {
		const result = await this.verifyWithFingerprint(token);
		return result ? result.user : null;
	};

	/**
	 * Verifies a token and atomically updates the password via `updatePassword`.
	 * Returns the verified user only when the update reports true; returns null
	 * for an invalid token or a lost update race. Hashing/storage errors propagate.
	 */
	readonly reset = async (token: string, password: string): Promise<TUser | null> => {
		const result = await this.verifyWithFingerprint(token);
		if (!result) return null;

		const hash = this.options.hash ?? hashPassword;
		const passwordHash = await hash(password);
		const updated = await this.options.updatePassword(
			result.user,
			passwordHash,
			result.fingerprint,
		);
		return updated === true ? result.user : null;
	};
}
