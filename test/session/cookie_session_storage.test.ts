/**
 * Verifies `CookieSessionStorage` (a `SessionStorage` backed by signed
 * cookies) (docs/testing.md L1). Checks the signature round trip, tamper
 * detection, key rotation, and `destroy`'s deletion cookie.
 */
import { describe, expect, test } from "vite-plus/test";
import { CookieSessionStorage } from "../../src/session/cookie_session_storage.js";
import { Session } from "../../src/session/session.js";
import { encodeBase64Url } from "../../src/support/base64url.js";

/**
 * Reproduces `CookieSessionStorage`'s private `sign()` using the same
 * `secret`, so tests can construct a validly-signed cookie value whose
 * payload is not a plain object (to probe the `isSessionData` guard).
 */
const signWithSecret = async (secret: string, jsonPayload: string): Promise<string> => {
	const payload = encodeBase64Url(new TextEncoder().encode(jsonPayload));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
};

/** Extracts the `name=value` part from a `Set-Cookie` value that can be sent as the `Cookie` header on the next request. */
const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("CookieSessionStorage", () => {
	test("restores the same data when the committed Cookie is passed to get", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("returns an empty session when the Cookie header is null", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });

		const session = await storage.get(null);

		expect(session.get("userId")).toBeUndefined();
	});

	test("a Cookie with a tampered value is treated as an empty session (does not throw)", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await storage.commit(session);
		const [name, value] = toCookieHeader(setCookie).split("=");

		const tampered = `${name}=${value}00`;
		const restored = await storage.get(tampered);

		expect(restored.get("userId")).toBeUndefined();
	});

	test("key rotation: a Cookie signed with the old key can still be verified when it is not first in the new key list", async () => {
		const oldStorage = new CookieSessionStorage({ secrets: ["old-secret"] });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await oldStorage.commit(session);

		const rotatedStorage = new CookieSessionStorage({ secrets: ["new-secret", "old-secret"] });
		const restored = await rotatedStorage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("after key rotation, a signature matching no key results in an empty session", async () => {
		const oldStorage = new CookieSessionStorage({ secrets: ["old-secret"] });
		const session = new Session("");
		session.set("userId", "u_1");
		const setCookie = await oldStorage.commit(session);

		const rotatedStorage = new CookieSessionStorage({ secrets: ["new-secret-only"] });
		const restored = await rotatedStorage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBeUndefined();
	});

	test("destroy returns a deletion Cookie value with Max-Age=0", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });

		const setCookie = await storage.destroy(new Session(""));

		expect(setCookie).toContain("Max-Age=0");
	});

	test("throws in the constructor when secrets is an empty array", () => {
		expect(() => new CookieSessionStorage({ secrets: [] })).toThrow();
	});

	test("a Cookie value with no separator between payload and signature is treated as an empty session", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });

		const session = await storage.get("session=no-separator-here");

		expect(session.get("userId")).toBeUndefined();
	});

	test("a Cookie value whose signature segment is not valid base64url is treated as an empty session", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"] });

		const session = await storage.get("session=some-payload.!!!invalid!!!");

		expect(session.get("userId")).toBeUndefined();
	});

	test("a validly signed payload that is not a plain object (array/string/number/null) is treated as an empty session", async () => {
		const secret = "secret-1";
		const storage = new CookieSessionStorage({ secrets: [secret] });

		for (const jsonPayload of [JSON.stringify([1, 2, 3]), JSON.stringify("hello"), "123", "null"]) {
			const value = await signWithSecret(secret, jsonPayload);
			const session = await storage.get(`session=${value}`);

			expect(session.data).toEqual({});
		}
	});

	test("the Cookie name can be changed via options.name", async () => {
		const storage = new CookieSessionStorage({ secrets: ["secret-1"], name: "custom_session" });
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);

		expect(setCookie.startsWith("custom_session=")).toBe(true);
	});
});
