/**
 * Verifies `Job`, `JobRegistry`, and `InlineJobQueue` (job definition, registry,
 * and the development-time enqueue adapter) (docs/testing.md L1).
 */
import { describe, expect, test } from "vite-plus/test";
import { InlineJobQueue } from "../../src/jobs/inline_job_queue.js";
import { Job } from "../../src/jobs/job.js";
import { assertValidEnqueueOptions } from "../../src/jobs/job_queue.js";
import { JobRegistry } from "../../src/jobs/job_registry.js";

type GreetJobPayload = { name: string };

/** A minimal job for tests, which records call contents into `calls`. */
class GreetJob extends Job<GreetJobPayload> {
	readonly name = "greet";
	readonly calls: GreetJobPayload[] = [];

	async perform(payload: GreetJobPayload): Promise<void> {
		this.calls.push(payload);
	}
}

describe("JobRegistry", () => {
	test("a registered job can be looked up with resolve", () => {
		const registry = new JobRegistry();
		const job = new GreetJob();

		registry.register(job);
		const registered = registry.resolve("greet");

		expect(registered?.name).toBe("greet");
	});

	test("resolve returns undefined for an unregistered job name", () => {
		const registry = new JobRegistry();

		expect(registry.resolve("unknown")).toBeUndefined();
	});

	test("registering a job with the same name twice throws", () => {
		const registry = new JobRegistry();
		registry.register(new GreetJob());

		expect(() => registry.register(new GreetJob())).toThrow(/greet/);
	});

	test("perform on the resolved instance delegates to the job's own perform", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);

		const registered = registry.resolve("greet");
		await registered?.perform({ name: "Taro" });

		expect(job.calls).toEqual([{ name: "Taro" }]);
	});
});

describe("InlineJobQueue", () => {
	test("enqueue immediately runs perform via JobRegistry", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);

		await new InlineJobQueue(registry).enqueue(job, { name: "Hanako" });

		expect(job.calls).toEqual([{ name: "Hanako" }]);
	});

	test("enqueueing a job not registered in JobRegistry throws", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();

		await expect(new InlineJobQueue(registry).enqueue(job, { name: "Hanako" })).rejects.toThrow(
			/greet/,
		);
	});

	test("specifying delaySeconds still runs perform immediately, without delay", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);

		await new InlineJobQueue(registry).enqueue(job, { name: "Hanako" }, { delaySeconds: 60 });

		expect(job.calls).toEqual([{ name: "Hanako" }]);
	});

	test("specifying an invalid delaySeconds throws without running perform", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);

		await expect(
			new InlineJobQueue(registry).enqueue(job, { name: "Hanako" }, { delaySeconds: -1 }),
		).rejects.toThrow(/delaySeconds/);
		expect(job.calls).toEqual([]);
	});
});

describe("assertValidEnqueueOptions", () => {
	test("undefined is OK", () => {
		expect(() => assertValidEnqueueOptions(undefined)).not.toThrow();
	});

	test("an empty object is OK", () => {
		expect(() => assertValidEnqueueOptions({})).not.toThrow();
	});

	test("delaySeconds: 0 is OK", () => {
		expect(() => assertValidEnqueueOptions({ delaySeconds: 0 })).not.toThrow();
	});

	test("delaySeconds: 60 is OK", () => {
		expect(() => assertValidEnqueueOptions({ delaySeconds: 60 })).not.toThrow();
	});

	test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"delaySeconds: %p throws",
		(delaySeconds) => {
			expect(() => assertValidEnqueueOptions({ delaySeconds })).toThrow(/delaySeconds/);
		},
	);

	test("priority: -1 (negative) is OK", () => {
		expect(() => assertValidEnqueueOptions({ priority: -1 })).not.toThrow();
	});

	test("priority omitted is OK", () => {
		expect(() => assertValidEnqueueOptions({ priority: undefined })).not.toThrow();
	});

	test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"priority: %p (non-integer) throws",
		(priority) => {
			expect(() => assertValidEnqueueOptions({ priority })).toThrow(/priority/);
		},
	);
});
