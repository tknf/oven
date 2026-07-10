/**
 * Verifies `Session` (the session data object) (docs/testing.md L1). Checks
 * get/set/has/unset, flash's consume-once semantics, and the tracking
 * conditions for `isDirty` and `isDestroyed`.
 */
import { describe, expect, test } from "vite-plus/test";
import { isSessionData, Session } from "../../src/session/session.js";

describe("Session", () => {
	test("can retrieve a set value via get", () => {
		const session = new Session("");

		session.set("userId", "u_1");

		expect(session.get("userId")).toBe("u_1");
	});

	test("returns undefined for an unset key", () => {
		const session = new Session("");

		expect(session.get("missing")).toBeUndefined();
	});

	test("has returns whether regular data exists", () => {
		const session = new Session("");
		session.set("userId", "u_1");

		expect(session.has("userId")).toBe(true);
		expect(session.has("missing")).toBe(false);
	});

	test("a value that has been unset can no longer be retrieved via get", () => {
		const session = new Session("");
		session.set("userId", "u_1");

		session.unset("userId");

		expect(session.get("userId")).toBeUndefined();
	});

	test("initial data passed to the constructor can be retrieved via get", () => {
		const session = new Session("s_1", { userId: "u_1" });

		expect(session.get("userId")).toBe("u_1");
		expect(session.id).toBe("s_1");
	});

	test("a value flashed can be retrieved on the first get", () => {
		const session = new Session("");

		session.flash("error", "login failed");

		expect(session.get("error")).toBe("login failed");
	});

	test("a flashed value is consumed after one get and becomes undefined on the second (consume-once)", () => {
		const session = new Session("");
		session.flash("error", "login failed");

		session.get("error");

		expect(session.get("error")).toBeUndefined();
	});

	test("a flashed value stays in data as long as it has never been retrieved via get", () => {
		const session = new Session("");

		session.flash("error", "login failed");

		expect(Object.keys(session.data)).toContain("__flash_error__");
	});

	test("has treats an unconsumed flash value as existing", () => {
		const session = new Session("");
		session.flash("error", "login failed");

		expect(session.has("error")).toBe(true);
	});

	test("isDirty is false for a new session", () => {
		const session = new Session("", { userId: "u_1" });

		expect(session.isDirty).toBe(false);
	});

	test("isDirty becomes true after set", () => {
		const session = new Session("");

		session.set("userId", "u_1");

		expect(session.isDirty).toBe(true);
	});

	test("isDirty becomes true after unset", () => {
		const session = new Session("", { userId: "u_1" });

		session.unset("userId");

		expect(session.isDirty).toBe(true);
	});

	test("isDirty becomes true after flash", () => {
		const session = new Session("");

		session.flash("error", "boom");

		expect(session.isDirty).toBe(true);
	});

	test("isDirty does not become true from merely getting regular data", () => {
		const session = new Session("", { userId: "u_1" });

		session.get("userId");

		expect(session.isDirty).toBe(false);
	});

	test("a get that consumes a flash value makes isDirty true", () => {
		const session = new Session("", { __flash_error__: "boom" });

		session.get("error");

		expect(session.isDirty).toBe(true);
	});

	test("isDestroyed is false for a new session", () => {
		const session = new Session("");

		expect(session.isDestroyed).toBe(false);
	});

	test("isDestroyed becomes true after markDestroyed", () => {
		const session = new Session("");

		session.markDestroyed();

		expect(session.isDestroyed).toBe(true);
	});
});

describe("isSessionData", () => {
	test("true for a plain object", () => {
		expect(isSessionData({ a: 1 })).toBe(true);
		expect(isSessionData({})).toBe(true);
	});

	test("false for arrays, null, and primitives", () => {
		expect(isSessionData([])).toBe(false);
		expect(isSessionData(null)).toBe(false);
		expect(isSessionData("text")).toBe(false);
		expect(isSessionData(1)).toBe(false);
	});
});
