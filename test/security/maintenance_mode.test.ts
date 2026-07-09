/**
 * Verifies `MaintenanceMode` (a maintenance mode middleware backed by
 * `KeyValueStore`): fail-open, the 503 response, prefix matching for
 * allowPaths, overriding render, and enabled transitions.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import {
	MaintenanceMode,
	type MaintenanceModeOptions,
} from "../../src/security/maintenance_mode.js";

const buildApp = (maintenanceMode: MaintenanceMode) => {
	const app = new Hono();
	app.use(maintenanceMode.use);
	app.get("/", (c) => c.text("ok"));
	app.get("/up", (c) => c.text("healthy"));
	app.get("/up/db", (c) => c.text("db healthy"));
	app.get("/status", (c) => c.text("status"));
	return app;
};

const buildMaintenanceMode = (options?: MaintenanceModeOptions) =>
	new MaintenanceMode(new InMemoryKeyValueStore(), options);

describe("MaintenanceMode", () => {
	test("passes through when not set (fail-open)", async () => {
		const maintenanceMode = buildMaintenanceMode();
		const app = buildApp(maintenanceMode);

		const res = await app.request("/");

		expect(res.status).toBe(200);
	});

	test("returns 503 and Retry-After after enable", async () => {
		const maintenanceMode = buildMaintenanceMode();
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const res = await app.request("/");

		expect(res.status).toBe(503);
		expect(res.headers.get("Retry-After")).toBe("600");
	});

	test("reflects the retryAfterSeconds option in the response header", async () => {
		const maintenanceMode = buildMaintenanceMode({ retryAfterSeconds: 30 });
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const res = await app.request("/");

		expect(res.headers.get("Retry-After")).toBe("30");
	});

	test("the default allowPaths (/up) pass through even while enabled", async () => {
		const maintenanceMode = buildMaintenanceMode();
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const res = await app.request("/up");

		expect(res.status).toBe(200);
	});

	test("allowPaths is matched by prefix", async () => {
		const maintenanceMode = buildMaintenanceMode();
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const res = await app.request("/up/db");

		expect(res.status).toBe(200);
	});

	test("specifying allowPaths replaces the default /up", async () => {
		const maintenanceMode = buildMaintenanceMode({ allowPaths: ["/status"] });
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const up = await app.request("/up");
		const status = await app.request("/status");

		expect(up.status).toBe(503);
		expect(status.status).toBe(200);
	});

	test("passes through after disable", async () => {
		const maintenanceMode = buildMaintenanceMode();
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		await maintenanceMode.disable();
		const res = await app.request("/");

		expect(res.status).toBe(200);
	});

	test("the render option can override the response", async () => {
		const render = (c: Context) => c.json({ message: "under maintenance" }, 503);
		const maintenanceMode = buildMaintenanceMode({ render });
		const app = buildApp(maintenanceMode);

		await maintenanceMode.enable();
		const res = await app.request("/");

		expect(res.status).toBe(503);
		await expect(res.json()).resolves.toEqual({ message: "under maintenance" });
	});

	test("the return value of enabled transitions with enable/disable", async () => {
		const maintenanceMode = buildMaintenanceMode();

		await expect(maintenanceMode.enabled()).resolves.toBe(false);

		await maintenanceMode.enable();
		await expect(maintenanceMode.enabled()).resolves.toBe(true);

		await maintenanceMode.disable();
		await expect(maintenanceMode.enabled()).resolves.toBe(false);
	});
});
