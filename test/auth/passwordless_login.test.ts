/**
 * Tests `PasswordlessLogin` (the magic-link login flow). Verifies enumeration
 * prevention on request, the token being embedded in the delivered email,
 * verification, invalid/expired tokens, that `verify` never rotates the
 * nonce, and that `login` rotates it on success so the used token — and any
 * other outstanding token — is rejected afterward (genuine single-use). Also
 * verifies the single-use guarantee holds under concurrency, since
 * `rotateNonce` is a compare-and-swap contract, not a blind write.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { PasswordlessLogin } from "../../src/auth/passwordless_login.js";

type StubUser = {
	id: string;
	email: string;
	loginNonce: string;
};

const buildUsers = (): StubUser[] => [
	{ id: "user-1", email: "user1@example.com", loginNonce: "nonce-a" },
];

/** Builds a `PasswordlessLogin` for tests together with a spy that records delivered emails. */
const buildFlow = (users: StubUser[], options?: { secrets?: string[] }) => {
	const delivered: { user: StubUser; url: string }[] = [];
	const rotated: StubUser[] = [];
	let nonceCounter = 0;

	const flow = new PasswordlessLogin<StubUser>({
		secrets: options?.secrets ?? ["secret-1"],
		findByEmail: (email) => users.find((user) => user.email === email),
		provider: (identity) => users.find((user) => user.id === identity),
		identityOf: (user) => user.id,
		fingerprintOf: (user) => user.loginNonce,
		loginUrl: (token) => `https://example.com/login?token=${token}`,
		deliver: (user, url) => {
			delivered.push({ user, url });
		},
		/**
		 * A real compare-and-swap against the in-memory `loginNonce`: only
		 * rotates (and records the win in `rotated`) when the stored nonce
		 * still equals `expectedNonce`, matching the atomic-UPDATE contract
		 * `PasswordlessLoginOptions.rotateNonce` documents. Returns `false`
		 * without mutating anything when another caller already rotated it.
		 */
		rotateNonce: (user, expectedNonce) => {
			if (user.loginNonce !== expectedNonce) return false;
			nonceCounter += 1;
			user.loginNonce = `nonce-${nonceCounter}-rotated`;
			rotated.push(user);
			return true;
		},
	});

	return { flow, delivered, rotated };
};

/** Extracts the token portion from a URL captured by the email-delivery spy. */
const extractToken = (url: string): string => {
	const token = new URL(url).searchParams.get("token");
	if (!token) throw new Error("URL does not contain a token");
	return token;
};

describe("PasswordlessLogin", () => {
	test("request calls deliver with a URL containing the token when the email exists", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await flow.request("user1@example.com");

		expect(delivered).toHaveLength(1);
		expect(delivered[0].user.id).toBe("user-1");
		expect(delivered[0].url).toContain("https://example.com/login?token=");
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

	test("verify returns null for a token issued under a different purpose", async () => {
		const users = buildUsers();
		const { flow } = buildFlow(users);

		let capturedUrl = "";
		const emailedFlow = new PasswordlessLogin<StubUser>({
			secrets: ["secret-1"],
			purpose: "oven:some_other_purpose",
			findByEmail: (email) => users.find((user) => user.email === email),
			provider: (identity) => users.find((user) => user.id === identity),
			identityOf: (user) => user.id,
			fingerprintOf: (user) => user.loginNonce,
			loginUrl: (token) => `https://example.com/login?token=${token}`,
			deliver: (_user, url) => {
				capturedUrl = url;
			},
			rotateNonce: () => true,
		});
		await emailedFlow.request("user1@example.com");
		const token = extractToken(capturedUrl);

		await expect(flow.verify(token)).resolves.toBeNull();
	});

	test("verify does not rotate the nonce, so calling it twice still succeeds", async () => {
		const users = buildUsers();
		const { flow, delivered, rotated } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		const first = await flow.verify(token);
		const second = await flow.verify(token);

		expect(first?.id).toBe("user-1");
		expect(second?.id).toBe("user-1");
		expect(rotated).toHaveLength(0);
	});

	test("login returns the user and rotates the nonce", async () => {
		const users = buildUsers();
		const { flow, delivered, rotated } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);
		const previousNonce = users[0].loginNonce;

		const user = await flow.login(token);

		expect(user?.id).toBe("user-1");
		expect(rotated).toHaveLength(1);
		expect(users[0].loginNonce).not.toBe(previousNonce);
	});

	test("replaying the same token after login returns null (single-use via rotated nonce)", async () => {
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		await flow.login(token);

		await expect(flow.login(token)).resolves.toBeNull();
		await expect(flow.verify(token)).resolves.toBeNull();
	});

	test("a second distinct outstanding token issued before login is also invalidated by the rotation", async () => {
		// `DataToken` signs `{ identity, purpose, expiresAt }` deterministically, so
		// two `request()` calls within the same wall-clock second (identical
		// `expiresAt`, unrotated fingerprint) would otherwise produce byte-identical
		// tokens. Advance the clock between the two requests so they are genuinely
		// distinct outstanding tokens, as this test's name promises.
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
			const users = buildUsers();
			const { flow, delivered } = buildFlow(users);

			await flow.request("user1@example.com");
			const firstToken = extractToken(delivered[0].url);

			vi.setSystemTime(new Date("2026-07-05T00:00:01.000Z"));
			await flow.request("user1@example.com");
			const secondToken = extractToken(delivered[1].url);

			expect(firstToken).not.toBe(secondToken);

			await flow.login(firstToken);

			await expect(flow.login(secondToken)).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	test("two concurrent login calls for the same token: exactly one wins the nonce CAS and only that call resolves to the user", async () => {
		const users = buildUsers();
		const { flow, delivered, rotated } = buildFlow(users);

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);

		// Both requests race to consume the same single-use link, e.g. a mail
		// client prefetching the link and a genuine click, or a double-click.
		const [first, second] = await Promise.all([flow.login(token), flow.login(token)]);

		const winners = [first, second].filter((user) => user !== null);
		expect(winners).toHaveLength(1);
		expect(winners[0]?.id).toBe("user-1");
		// `rotateNonce` only actually changed the row (won the CAS) exactly once.
		expect(rotated).toHaveLength(1);
	});
});
