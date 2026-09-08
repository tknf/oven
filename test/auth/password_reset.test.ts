/**
 * Tests `PasswordReset` (the password reset flow). Verifies enumeration prevention on
 * request, the token being embedded in the delivered email, verification, updating the
 * password, automatic invalidation after the update, invalid/expired tokens, prevention
 * of cross-purpose reuse, and overriding the `hash` option.
 */
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";
import type { PasswordResetOptions } from "../../src/auth/password_reset.js";
import { describe, expect, test, vi } from "vite-plus/test";
import { EmailVerification } from "../../src/auth/email_verification.js";
import { PasswordReset } from "../../src/auth/password_reset.js";
import { verifyPassword } from "../../src/auth/password.js";

/** Releases all participants after each has reached the same asynchronous boundary. */
const buildBarrier = (participants: number) => {
	let release: (() => void) | undefined;
	let arrivals = 0;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	return async () => {
		arrivals += 1;
		if (arrivals === participants) release?.();
		await ready;
	};
};

type StubUser = {
	id: string;
	email: string;
	passwordHash: string;
};

const buildUsers = (): StubUser[] => [
	{ id: "user-1", email: "user1@example.com", passwordHash: "pbkdf2$100000$salt-a$hash-a" },
];

/** Builds a `PasswordReset` for tests together with a spy that records delivered emails. */
const buildFlow = (
	users: StubUser[],
	options?: Partial<Pick<PasswordResetOptions<StubUser>, "secrets" | "hash" | "updatePassword">>,
) => {
	const delivered: { user: StubUser; url: string }[] = [];
	const updated: { user: StubUser; passwordHash: string }[] = [];

	const flow = new PasswordReset<StubUser>({
		secrets: options?.secrets ?? ["secret-1"],
		findByEmail: (email) => users.find((user) => user.email === email),
		provider: (identity) => users.find((user) => user.id === identity),
		identityOf: (user) => user.id,
		fingerprintOf: (user) => user.passwordHash,
		resetUrl: (token) => `https://example.com/reset?token=${token}`,
		deliver: (user, url) => {
			delivered.push({ user, url });
		},
		updatePassword: (user, passwordHash, expectedFingerprint) => {
			if (user.passwordHash !== expectedFingerprint) return false;
			user.passwordHash = passwordHash;
			updated.push({ user, passwordHash });
			return true;
		},
		...options,
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
			fingerprintOf: (user) => user.passwordHash,
			resetUrl: (token) => `https://example.com/reset?token=${token}`,
			deliver: (user, url) => {
				delivered.push({ user, url });
			},
			updatePassword: (user, passwordHash, expectedFingerprint) => {
				if (user.passwordHash !== expectedFingerprint) return false;
				user.passwordHash = passwordHash;
				updated.push({ user, passwordHash });
				return true;
			},
			hash: customHash,
		});

		await flow.request("user1@example.com");
		const token = extractToken(delivered[0].url);
		await flow.reset(token, "new-password");

		expect(customHash).toHaveBeenCalledWith("new-password");
		expect(updated[0].passwordHash).toBe("custom$new-password");
	});
	test("two flow instances sharing a database allow exactly one concurrent reset", async () => {
		const ctx = await createTestDb({
			schema,
			migrationsFolder: new URL("../test_support/fixtures/migrations", import.meta.url).pathname,
		});
		try {
			const [user] = buildUsers();
			if (!user) throw new Error("missing test user");
			await ctx.db.insert(schema.adminOperators).values({
				...user,
				username: "operator",
				createdAt: 0,
				updatedAt: 0,
			});
			const find = async (where: ReturnType<typeof eq>) => {
				const [row] = await ctx.db.select().from(schema.adminOperators).where(where);
				return row;
			};
			const bothVerified = buildBarrier(2);
			const expected: string[] = [];
			let token = "";
			const options = {
				secrets: ["secret-1"],
				findByEmail: (email: string) => find(eq(schema.adminOperators.email, email)),
				provider: (id: string) => find(eq(schema.adminOperators.id, id)),
				identityOf: (user: StubUser) => user.id,
				fingerprintOf: (user: StubUser) => user.passwordHash,
				resetUrl: (value: string) => value,
				deliver: (_user: StubUser, value: string) => {
					token = value;
				},
				hash: async (password: string) => {
					await bothVerified();
					return `hash:${password}`;
				},
				updatePassword: async (user: StubUser, passwordHash: string, fingerprint: string) => {
					expected.push(fingerprint);
					const rows = await ctx.db
						.update(schema.adminOperators)
						.set({ passwordHash })
						.where(
							and(
								eq(schema.adminOperators.id, user.id),
								eq(schema.adminOperators.passwordHash, fingerprint),
							),
						)
						.returning({ id: schema.adminOperators.id });
					return rows.length === 1;
				},
			} satisfies PasswordResetOptions<StubUser>;
			const first = new PasswordReset(options);
			const second = new PasswordReset(options);
			await first.request(user.email);
			const results = await Promise.all([
				first.reset(token, "first"),
				second.reset(token, "second"),
			]);
			expect(results.filter((result) => result !== null)).toHaveLength(1);
			expect(expected).toEqual([user.passwordHash, user.passwordHash]);
			const winner = results[0] ? "first" : "second";
			expect((await find(eq(schema.adminOperators.id, user.id)))?.passwordHash).toBe(
				`hash:${winner}`,
			);
			await expect(first.verify(token)).resolves.toBeNull();
		} finally {
			ctx.client.close();
		}
	});

	test("captures the verified fingerprint even when the shared user changes during hashing", async () => {
		const users = buildUsers();
		const [user] = users;
		if (!user) throw new Error("missing test user");
		const verifiedHash = user.passwordHash;
		const updatePassword = vi.fn(
			(_user: StubUser, _hash: string, expected: string) => user.passwordHash === expected,
		);
		const { flow, delivered } = buildFlow(users, {
			hash: async () => {
				user.passwordHash = "changed-elsewhere";
				return "new-hash";
			},
			updatePassword,
		});
		await flow.request(user.email);
		await expect(flow.reset(extractToken(delivered[0].url), "password")).resolves.toBeNull();
		expect(updatePassword).toHaveBeenCalledWith(user, "new-hash", verifiedHash);
		expect(user.passwordHash).toBe("changed-elsewhere");
	});

	test("invalid tokens do not hash or update passwords", async () => {
		const hash = vi.fn(async () => "hash");
		const updatePassword = vi.fn(() => true);
		const { flow } = buildFlow(buildUsers(), { hash, updatePassword });
		await expect(flow.reset("invalid", "password")).resolves.toBeNull();
		expect(hash).not.toHaveBeenCalled();
		expect(updatePassword).not.toHaveBeenCalled();
	});

	test("verification alone does not consume the token", async () => {
		const users = buildUsers();
		const { flow, delivered, updated } = buildFlow(users);
		await flow.request(users[0].email);
		const token = extractToken(delivered[0].url);
		await expect(flow.verify(token)).resolves.toBe(users[0]);
		await expect(flow.verify(token)).resolves.toBe(users[0]);
		expect(updated).toHaveLength(0);
	});

	test("an update error propagates without reporting a successful reset", async () => {
		const error = new Error("database unavailable");
		const users = buildUsers();
		const { flow, delivered } = buildFlow(users, {
			hash: async () => "hash",
			updatePassword: async () => {
				throw error;
			},
		});
		await flow.request(users[0].email);
		await expect(flow.reset(extractToken(delivered[0].url), "password")).rejects.toBe(error);
	});
});
