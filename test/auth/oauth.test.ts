/**
 * Tests `OAuthClient` (a dependency-free OAuth 2.0 client). Verifies authorization URL
 * assembly, code exchange, refresh, user info retrieval, the PKCE helpers (using the
 * RFC 7636 Appendix B test vectors), and ID Token decoding.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import {
	codeChallengeS256,
	decodeIdToken,
	generateCodeVerifier,
	generateState,
	OAuthClient,
	OAuthError,
} from "../../src/auth/oauth.js";
import { encodeBase64Url } from "../../src/support/base64url.js";

const buildClient = (fetchImpl: typeof fetch, overrides?: { clientSecret?: string }) =>
	new OAuthClient({
		authorizationEndpoint: "https://provider.example.com/authorize",
		tokenEndpoint: "https://provider.example.com/token",
		userInfoEndpoint: "https://provider.example.com/userinfo",
		clientId: "client-1",
		clientSecret: overrides?.clientSecret,
		fetch: fetchImpl,
	});

const jsonResponse = (body: Record<string, unknown>, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** Extracts `RequestInit.body` (the form-encoded string). Returns an empty string if it is not a string. */
const requestBody = (init: RequestInit | undefined): string =>
	typeof init?.body === "string" ? init.body : "";

describe("OAuthClient", () => {
	describe("authorizationUrl", () => {
		test("attaches the required parameters (response_type/client_id/redirect_uri/state)", () => {
			const client = buildClient(vi.fn<typeof fetch>());

			const url = new URL(
				client.authorizationUrl({
					redirectUri: "https://app.example.com/callback",
					state: "state-1",
				}),
			);

			expect(url.origin + url.pathname).toBe("https://provider.example.com/authorize");
			expect(url.searchParams.get("response_type")).toBe("code");
			expect(url.searchParams.get("client_id")).toBe("client-1");
			expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.com/callback");
			expect(url.searchParams.get("state")).toBe("state-1");
		});

		test("scopes become the scope parameter joined by spaces", () => {
			const client = buildClient(vi.fn<typeof fetch>());

			const url = new URL(
				client.authorizationUrl({
					redirectUri: "https://app.example.com/callback",
					state: "state-1",
					scopes: ["openid", "email", "profile"],
				}),
			);

			expect(url.searchParams.get("scope")).toBe("openid email profile");
		});

		test("attaches code_challenge and code_challenge_method=S256 when codeChallenge is specified", () => {
			const client = buildClient(vi.fn<typeof fetch>());

			const url = new URL(
				client.authorizationUrl({
					redirectUri: "https://app.example.com/callback",
					state: "state-1",
					codeChallenge: "challenge-value",
				}),
			);

			expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
			expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		});

		test("extraParams are appended as-is", () => {
			const client = buildClient(vi.fn<typeof fetch>());

			const url = new URL(
				client.authorizationUrl({
					redirectUri: "https://app.example.com/callback",
					state: "state-1",
					extraParams: { access_type: "offline", prompt: "consent" },
				}),
			);

			expect(url.searchParams.get("access_type")).toBe("offline");
			expect(url.searchParams.get("prompt")).toBe("consent");
		});
	});

	describe("exchangeCode", () => {
		test("repacks the snake_case response into OAuthTokens on success (with refresh_token/id_token present)", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({
					access_token: "access-1",
					token_type: "Bearer",
					expires_in: 3600,
					refresh_token: "refresh-1",
					scope: "openid email",
					id_token: "id-token-1",
				}),
			);
			const client = buildClient(fetchFn, { clientSecret: "secret-1" });

			const tokens = await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			expect(tokens.accessToken).toBe("access-1");
			expect(tokens.tokenType).toBe("Bearer");
			expect(tokens.expiresIn).toBe(3600);
			expect(tokens.refreshToken).toBe("refresh-1");
			expect(tokens.scope).toBe("openid email");
			expect(tokens.idToken).toBe("id-token-1");
			expect(tokens.raw.access_token).toBe("access-1");
		});

		test("a response without refresh_token/id_token yields undefined", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-1", token_type: "Bearer" }),
			);
			const client = buildClient(fetchFn);

			const tokens = await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			expect(tokens.refreshToken).toBeUndefined();
			expect(tokens.idToken).toBeUndefined();
		});

		test("a response containing an error field throws OAuthError", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ error: "invalid_grant", error_description: "invalid code" }),
			);
			const client = buildClient(fetchFn);

			const promise = client.exchangeCode({
				code: "bad-code",
				redirectUri: "https://app.example.com/callback",
			});

			await expect(promise).rejects.toBeInstanceOf(OAuthError);
			await expect(promise).rejects.toMatchObject({
				error: "invalid_grant",
				errorDescription: "invalid code",
			});
		});

		test("a non-2xx response throws OAuthError", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}, 500));
			const client = buildClient(fetchFn);

			const promise = client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			await expect(promise).rejects.toBeInstanceOf(OAuthError);
			await expect(promise).rejects.toMatchObject({ status: 500 });
		});

		test("client_secret is included in the body when it is configured", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-1", token_type: "Bearer" }),
			);
			const client = buildClient(fetchFn, { clientSecret: "secret-1" });

			await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			const request = fetchFn.mock.calls[0]?.[1];
			const body = requestBody(request);
			expect(new URLSearchParams(body).get("client_secret")).toBe("secret-1");
		});

		test("client_secret is not included in the body when it is not configured", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-1", token_type: "Bearer" }),
			);
			const client = buildClient(fetchFn);

			await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			const request = fetchFn.mock.calls[0]?.[1];
			const body = requestBody(request);
			expect(new URLSearchParams(body).has("client_secret")).toBe(false);
		});

		test("passing codeVerifier includes code_verifier in the body", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-1", token_type: "Bearer" }),
			);
			const client = buildClient(fetchFn);

			await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
				codeVerifier: "verifier-1",
			});

			const request = fetchFn.mock.calls[0]?.[1];
			const body = requestBody(request);
			expect(new URLSearchParams(body).get("code_verifier")).toBe("verifier-1");
			expect(new URLSearchParams(body).get("grant_type")).toBe("authorization_code");
		});
	});

	describe("refresh", () => {
		test("sends with grant_type=refresh_token and repacks the result on success", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-2", token_type: "Bearer", expires_in: 1800 }),
			);
			const client = buildClient(fetchFn);

			const tokens = await client.refresh("refresh-1");

			expect(tokens.accessToken).toBe("access-2");
			expect(tokens.expiresIn).toBe(1800);

			const request = fetchFn.mock.calls[0]?.[1];
			const body = requestBody(request);
			expect(new URLSearchParams(body).get("grant_type")).toBe("refresh_token");
			expect(new URLSearchParams(body).get("refresh_token")).toBe("refresh-1");
		});
	});

	describe("timeoutMs", () => {
		test("when specified, an unresponsive upstream is aborted via AbortSignal", async () => {
			const fetchFn = vi.fn<typeof fetch>(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						const signal = init?.signal;
						if (!signal) throw new Error("signal was not passed");
						signal.addEventListener("abort", () => reject(signal.reason));
					}),
			);
			const client = new OAuthClient({
				authorizationEndpoint: "https://provider.example.com/authorize",
				tokenEndpoint: "https://provider.example.com/token",
				clientId: "client-1",
				fetch: fetchFn,
				timeoutMs: 5,
			});

			await expect(
				client.exchangeCode({
					code: "code-1",
					redirectUri: "https://app.example.com/callback",
				}),
			).rejects.toThrow();
		});

		test("fetch is called without a signal as before when not specified", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () =>
				jsonResponse({ access_token: "access-1", token_type: "Bearer" }),
			);
			const client = buildClient(fetchFn);

			await client.exchangeCode({
				code: "code-1",
				redirectUri: "https://app.example.com/callback",
			});

			const init = fetchFn.mock.calls[0]?.[1];
			expect(init?.signal).toBeUndefined();
		});
	});

	describe("fetchUserInfo", () => {
		test("issues a GET with an Authorization: Bearer header", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({ sub: "user-1" }));
			const client = buildClient(fetchFn);

			const info = await client.fetchUserInfo("access-1");

			expect(info.sub).toBe("user-1");
			const request = fetchFn.mock.calls[0]?.[1];
			const headers = new Headers(request?.headers);
			expect(headers.get("authorization")).toBe("Bearer access-1");
		});

		test("throws when userInfoEndpoint is not configured", async () => {
			const client = new OAuthClient({
				authorizationEndpoint: "https://provider.example.com/authorize",
				tokenEndpoint: "https://provider.example.com/token",
				clientId: "client-1",
				fetch: vi.fn<typeof fetch>(),
			});

			await expect(client.fetchUserInfo("access-1")).rejects.toThrow(/userInfoEndpoint/);
		});

		test("a non-2xx response throws OAuthError", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse({}, 401));
			const client = buildClient(fetchFn);

			await expect(client.fetchUserInfo("access-1")).rejects.toBeInstanceOf(OAuthError);
		});
	});
});

describe("generateCodeVerifier/codeChallengeS256", () => {
	test("the generated verifier is a 43-character base64url string", () => {
		const verifier = generateCodeVerifier();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test("the generated state is a 43-character base64url string", () => {
		const state = generateState();
		expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	test("verifies the challenge against the RFC 7636 Appendix B test vectors", async () => {
		const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
		const challenge = await codeChallengeS256(verifier);
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
	});
});

describe("decodeIdToken", () => {
	test("decodes the payload of a well-formed JWT", () => {
		const payload = { sub: "user-1", email: "user@example.com" };
		const header = encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256" })));
		const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
		const idToken = `${header}.${body}.signature`;

		expect(decodeIdToken(idToken)).toEqual(payload);
	});

	test("throws when there are not exactly 3 parts", () => {
		expect(() => decodeIdToken("only-one-part")).toThrow(/JWT/);
	});

	test("throws when the payload is invalid base64url", () => {
		expect(() => decodeIdToken("header.!!!not-base64!!!.signature")).toThrow();
	});

	test("throws when the payload is invalid JSON", () => {
		const body = encodeBase64Url(new TextEncoder().encode("not-json"));
		expect(() => decodeIdToken(`header.${body}.signature`)).toThrow(/JSON/);
	});
});
