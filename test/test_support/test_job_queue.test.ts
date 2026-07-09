/**
 * Verifies `TestJobQueue`, the test `JobQueue` implementation provided by `@tknf/oven/test`.
 * Checks the recorded enqueue contents, typed retrieval via `enqueuedOf`, `clear()`, and
 * throwing on invalid options.
 */
import { describe, expect, test } from "vite-plus/test";
import { Job } from "../../src/jobs/job.js";
import { TestJobQueue } from "../../src/test/test_job_queue.js";

type GreetJobPayload = { name: string };

/** Minimal job for testing. */
class GreetJob extends Job<GreetJobPayload> {
	readonly name = "greet";

	async perform(_payload: GreetJobPayload): Promise<void> {}
}

type NotifyJobPayload = { message: string };

/** A separate job used to confirm that `enqueuedOf` excludes other jobs' records. */
class NotifyJob extends Job<NotifyJobPayload> {
	readonly name = "notify";

	async perform(_payload: NotifyJobPayload): Promise<void> {}
}

describe("TestJobQueue", () => {
	test("enqueued content accumulates in enqueued", async () => {
		const queue = new TestJobQueue();
		const job = new GreetJob();

		await queue.enqueue(job, { name: "Taro" }, { delaySeconds: 60 });

		expect(queue.enqueued).toEqual([
			{ name: "greet", payload: { name: "Taro" }, options: { delaySeconds: 60 } },
		]);
	});

	test("enqueuedOf retrieves only a specific job's payloads, typed", async () => {
		const queue = new TestJobQueue();
		const greetJob = new GreetJob();
		const notifyJob = new NotifyJob();

		await queue.enqueue(greetJob, { name: "Taro" });
		await queue.enqueue(notifyJob, { message: "Hello" });
		await queue.enqueue(greetJob, { name: "Hanako" });

		expect(queue.enqueuedOf(greetJob)).toEqual([{ name: "Taro" }, { name: "Hanako" }]);
	});

	test("enqueuedOf excludes other jobs' records", async () => {
		const queue = new TestJobQueue();
		const greetJob = new GreetJob();
		const notifyJob = new NotifyJob();

		await queue.enqueue(notifyJob, { message: "Hello" });

		expect(queue.enqueuedOf(greetJob)).toEqual([]);
	});

	test("clear() clears the enqueued records", async () => {
		const queue = new TestJobQueue();
		const job = new GreetJob();
		await queue.enqueue(job, { name: "Taro" });

		queue.clear();

		expect(queue.enqueued).toEqual([]);
	});

	test("specifying an invalid delaySeconds throws and is not recorded", async () => {
		const queue = new TestJobQueue();
		const job = new GreetJob();

		await expect(queue.enqueue(job, { name: "Taro" }, { delaySeconds: -1 })).rejects.toThrow(
			/delaySeconds/,
		);
		expect(queue.enqueued).toEqual([]);
	});

	test("specifying an invalid priority throws and is not recorded", async () => {
		const queue = new TestJobQueue();
		const job = new GreetJob();

		await expect(queue.enqueue(job, { name: "Taro" }, { priority: 1.5 })).rejects.toThrow(
			/priority/,
		);
		expect(queue.enqueued).toEqual([]);
	});
});
