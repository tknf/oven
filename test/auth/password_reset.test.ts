/**
 * Tests `PasswordReset` (the password reset flow). Verifies enumeration prevention on
 * request, the token being embedded in the delivered email, verification, updating the
 * password, automatic invalidation after the update, invalid/expired tokens, prevention
 * of cross-purpose reuse, and overriding the `hash` option.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { EmailVerification } from "../../src/auth/email_verification.js";
import { PasswordReset } from "../../src/auth/password_reset.js";
import { verifyPassword } from "../../src/auth/password.js";

type StubUser = {
	id: string;
	email: string;
	passwordHash: string;
};

const buildUsers = (): StubUser[] => [
	{ id: "user-1", email: "user1@example.com", passwordHash: "pbkdf2$100000$salt-a$hash-a" },
];

/** Builds a `PasswordReset` for tests together with a spy that records delivered emails. */
const buildFlow = (users: StubUser[], options?: { secrets?: string[] }) => {
	const delivered: { user: StubUser; url: string }[] = [];
	const updated: { user: StubUser; passwordHash: string }[] = [];

	const flow = new PasswordReset<StubUser>({
		secrets: options?.secrets ?? ["secret-1"],
		findByEmail: (email) => users.find((user) => user.email === email),
		provider: (identity) => users.find((user) => user.id === identity),
		identityOf: (user) => user.id,
		fingerprintOf: (user) => user.passwordHash.slice(-8),
		resetUrl: (token) => `https://example.com/reset?token=${token}`,
		deliver: (user, url) => {
			delivered.push({ user, url });
		},
		updatePassword: (user, passwordHash) => {
			user.passwordHash = passwordHash;
			updated.push({ user, passwordHash });
		},
	});

	return { flow, delivered, updated };
};

/** Extracts the token portion from a URL captured by the email-delivery spy. */
const extractToken = (url: string): string => {
	const token = new URL(url).searchParams.get("token");
	if (!token) throw new Error("URL does not contain a token");
	return token;
};

describe("PasswordReset", () => {
	test("request calls deliver with a URL containing the token when the email exists", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await flow.request("user1@example.com");

		expect(delivered).toHaveLength(1);
		expect(delivered[0].user.id).toBe("user-1");
		expect(delivered[0].url).toContain("https://example.com/reset?token=");
	});

	test("request does not call deliver and does not throw when the email does not exist", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await expect(flow.request("missing@example.com")).resolves.toBeUndefined();
		expect(delivered).toHaveLength(0);
	});

	test("verifying a token issued by request returns the correct user", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		const user = await flow.verify(token);
		expect(user?.id).toBe("user-1");
	});

	test("a successful reset calls updatePassword with the new hash and returns the user", async () => {
		const users = buildUsers();
		const { flow, delivered, updated } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		const user = await flow.reset(token, "new-password");

		expect(user?.id).toBe("user-1");
		expect(updated).toHaveLength(1);
		await expect(verifyPassword("new-password", updated[0].passwordHash)).resolves.toBe(true);
	});

	test("re-verifying the same token after reset returns null (automatic invalidation)", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		await flow.reset(token, "new-password");

		await expect(flow.verify(token)).resolves.toBeNull();
	});

	test("verify returns null for an invalid token", async () => {
		const users = buildUsers();
		const { flow } = buildFlow(users);

		await expect(flow.verify("invalid-token")).resolves.toBeNull();
	});

	test("verify returns null for an expired token", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
			const users = buildUsers();
			const { flow, delivered } = buildFlow(users);

			await flow.request("user1@example.com");
			const token = extractToken(delivered[0].url);

			vi.setSystemTime(new Date("2026-07-05T01:00:00.000Z"));
			await expect(flow.verify(token)).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test("passing an EmailVerification token to PasswordReset.verify returns null (prevents cross-purpose reuse)", async () => {
		const users = buildUsers();
		const { flow } = buildFlow(users);

		let capturedUrl = "";
		const emailFlow = new EmailVerification<StubUser>({
			secrets: ["secret-1"],
			provider: (identity) => users.find((user) => user.id === identity),
			identityOf: (user) => user.id,
			fingerprintOf: (user) => user.email,
			verificationUrl: (token) => `https://example.com/verify?token=${token}`,
			deliver: (_user, url) => {
				capturedUrl = url;
			},
			markVerified: () => {},
		});
		await emailFlow.request(users[0]);
		const token = extractToken(capturedUrl);

		await expect(flow.verify(token)).resolves.toBeNull();
	});

	test("overriding the hash option makes that hash function be used", async () => {
		const users = buildUsers();
		const customHash = vi.fn(async (password: string) => `custom$${password}`);
		const delivered: { user: StubUser; url: string }[] = [];
		const updated: { user: StubUser; passwordHash: string }[] = [];

		const flow = new PasswordReset<StubUser>({
			secrets: ["secret-1"],
			findByEmail: (email) => users.find((user) => user.email === email),
			provider: (identity) => users.find((user) => user.id === identity),
			identityOf: (user) => user.id,
			fingerprintOf: (user) => user.passwordHash.slice(-8),
			resetUrl: (token) => `https://example.com/reset?token=${token}`,
			deliver: (user, url) => {
				delivered.push({ user, url });
			},
			updatePassword: (user, passwordHash) => {
				user.passwordHash = passwordHash;
				updated.push({ user, passwordHash });
			},
			hash: customHash,
		});

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);
		await flow.reset(token, "new-password");

		expect(customHash).toHaveBeenCalledWith("new-password");
		expect(updated[0].passwordHash).toBe("custom$new-password");
	});
});
