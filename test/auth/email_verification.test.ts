/**
 * Tests `EmailVerification` (the email address verification flow). Verifies email
 * delivery on request, `markVerified` being called on successful confirmation, `verify`
 * not calling `markVerified`, automatic invalidation after an email address change, and
 * `null` being returned for invalid/expired tokens.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { EmailVerification } from "../../src/auth/email_verification.js";

type StubUser = {
	id: string;
	email: string;
	verified: boolean;
};

const buildUser = (): StubUser => ({ id: "user-1", email: "user1@example.com", verified: false });

/** Builds an `EmailVerification` for tests together with spies that record delivered emails and verified-state updates. */
const buildFlow = (users: StubUser[]) => {
	const delivered: { user: StubUser; url: string }[] = [];
	const verifiedUsers: StubUser[] = [];

	const flow = new EmailVerification<StubUser>({
		secrets: ["secret-1"],
		provider: (identity) => users.find((user) => user.id === identity),
		identityOf: (user) => user.id,
		fingerprintOf: (user) => user.email,
		verificationUrl: (token) => `https://example.com/verify?token=${token}`,
		deliver: (user, url) => {
			delivered.push({ user, url });
		},
		markVerified: (user) => {
			user.verified = true;
			verifiedUsers.push(user);
		},
	});

	return { flow, delivered, verifiedUsers };
};

/** Extracts the token portion from a URL captured by the email-delivery spy. */
const extractToken = (url: string): string => {
	const token = new URL(url).searchParams.get("token");
	if (!token) throw new Error("URL does not contain a token");
	return token;
};

describe("EmailVerification", () => {
	test("request calls deliver once with a URL that contains the token", async () => {
		const users = [buildUser()];
		const { flow, delivered } = buildFlow(users);

		await flow.request(users[0]);

		expect(delivered).toHaveLength(1);
		expect(delivered[0].url).toContain("https://example.com/verify?token=");
	});

	test("confirm calls markVerified once and returns the user for a valid token", async () => {
		const users = [buildUser()];
		const { flow, delivered, verifiedUsers } = buildFlow(users);

		await flow.request(users[0]);
		const token = extractToken(delivered[0].url);

		const user = await flow.confirm(token);

		expect(user?.id).toBe("user-1");
		expect(user?.verified).toBe(true);
		expect(verifiedUsers).toHaveLength(1);
	});

	test("verify does not call markVerified (display-only pre-check)", async () => {
		const users = [buildUser()];
		const { flow, delivered, verifiedUsers } = buildFlow(users);

		await flow.request(users[0]);
		const token = extractToken(delivered[0].url);

		const user = await flow.verify(token);

		expect(user?.id).toBe("user-1");
		expect(user?.verified).toBe(false);
		expect(verifiedUsers).toHaveLength(0);
	});

	test("confirm returns null after the email address has changed (automatic invalidation)", async () => {
		const users = [buildUser()];
		const { flow, delivered } = buildFlow(users);

		await flow.request(users[0]);
		const token = extractToken(delivered[0].url);

		users[0].email = "changed@example.com";

		await expect(flow.confirm(token)).resolves.toBeNull();
	});

	test("confirm returns null for an invalid token", async () => {
		const users = [buildUser()];
		const { flow } = buildFlow(users);

		await expect(flow.confirm("invalid-token")).resolves.toBeNull();
	});

	test("confirm returns null for an expired token", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
			const users = [buildUser()];
			const { flow, delivered } = buildFlow(users);

			await flow.request(users[0]);
			const token = extractToken(delivered[0].url);

			vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));
			await expect(flow.confirm(token)).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
