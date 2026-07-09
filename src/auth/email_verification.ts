/**
 * Email verification flow. Sends a confirmation email via `request(user)` right
 * after registration or an email address change, and marks the user verified
 * via `confirm(token)` from the URL in that email. Views, route wiring, and
 * composing the email body are the application's responsibility; this class is
 * a headless flow class that only ties together
 * "generate token -> build URL (injected by app) -> send email (injected by
 * app) -> verify -> update".
 *
 * By using the email being verified itself as the `DataToken` fingerprint, if
 * the email address is changed after the verification email was sent, the old
 * token is automatically invalidated, since the fingerprint no longer matches
 * the stored value.
 */
import { DataToken } from "./data_token.js";

export type EmailVerificationOptions<TUser> = {
	/** List of signing secrets. At least one is required. Signing uses the first entry; verification uses all entries (passed through to DataToken as-is). */
	secrets: string[];
	/** Token validity period in seconds. Default 86,400 (24 hours). */
	expiresInSeconds?: number;
	/** Purpose identifier for the token. Default "oven:email_verification". */
	purpose?: string;
	/** Resolves a user from an identifier (the same vocabulary as Guard's provider). */
	provider: (identity: string) => TUser | null | undefined | Promise<TUser | null | undefined>;
	/** Extracts the identifier from a user. */
	identityOf: (user: TUser) => string;
	/** Extracts the fingerprint from a user. Typically the email address being verified itself. */
	fingerprintOf: (user: TUser) => string;
	/** Builds the verification URL (the full URL placed in the email) from a token. */
	verificationUrl: (token: string) => string;
	/** Sends the verification email. Enqueueing to a DeliverMailJob etc. also happens here. */
	deliver: (user: TUser, url: string) => void | Promise<void>;
	/** Updates the user as verified. */
	markVerified: (user: TUser) => void | Promise<void>;
};

const DEFAULT_PURPOSE = "oven:email_verification";
const DEFAULT_EXPIRES_IN_SECONDS = 86_400;

/**
 * Runs the email verification flow. `request`/`verify`/`confirm` are declared
 * as arrow-function class fields because they may be passed by reference from
 * handlers.
 */
export class EmailVerification<TUser> {
	private readonly dataToken: DataToken;
	private readonly options: EmailVerificationOptions<TUser>;

	constructor(options: EmailVerificationOptions<TUser>) {
		this.options = options;
		this.dataToken = new DataToken({
			secrets: options.secrets,
			purpose: options.purpose ?? DEFAULT_PURPOSE,
			expiresInSeconds: options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
		});
	}

	/**
	 * Sends a verification email to `user`. No lookup is performed since the
	 * caller (right after registration, or while logged in) already holds the
	 * target user.
	 */
	readonly request = async (user: TUser): Promise<void> => {
		const token = await this.dataToken.generate(
			this.options.identityOf(user),
			this.options.fingerprintOf(user),
		);
		await this.options.deliver(user, this.options.verificationUrl(token));
	};

	/**
	 * Verifies a token and, on success, returns the target user. `markVerified`
	 * is not called, so this can also be used for display-only pre-verification.
	 * Returns `null` on failure (malformed, expired, or already invalidated).
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
	 * Verifies a token and, on success, marks the user as verified and returns
	 * them. Returns `null` on failure.
	 */
	readonly confirm = async (token: string): Promise<TUser | null> => {
		const user = await this.verify(token);
		if (!user) return null;

		await this.options.markVerified(user);
		return user;
	};
}
