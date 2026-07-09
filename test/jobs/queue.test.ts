/**
 * Verifies `CloudflareJobQueue` (the send format sent to the Queue binding) and
 * `QueueConsumer` (ack/retry and how unknown jobs are handled) (docs/testing.md L1).
 * The Queue binding and `MessageBatch`/`Message` are mimicked with minimal in-test stubs.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import type { JobMessage } from "../../src/cloudflare/cloudflare_job_queue.js";
import { CloudflareJobQueue } from "../../src/cloudflare/cloudflare_job_queue.js";
import { Job } from "../../src/jobs/job.js";
import { JobRegistry } from "../../src/jobs/job_registry.js";
import { QueueConsumer } from "../../src/cloudflare/queue_consumer.js";

/**
 * A minimal stub satisfying `Queue<JobMessage>`, returning the `send` mock itself.
 * (Passing a value accessed as an interface method property, like `queue.send`,
 * directly to `expect` triggers oxlint's `unbound-method` warning, so the mock is
 * kept in a variable and that is used for assertions instead.)
 */
const buildQueueStub = () => {
	const send = vi.fn(async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }));
	const queue: Queue<JobMessage> = { metrics: vi.fn(), send, sendBatch: vi.fn() };
	return { queue, send };
};

/**
 * A minimal stub satisfying `Message<JobMessage>`, returning the `ack`/`retry`
 * mocks themselves (see the comment on `buildQueueStub` for why).
 */
const buildMessage = (body: JobMessage) => {
	const ack = vi.fn();
	const retry = vi.fn();
	const message: Message<JobMessage> = {
		id: "msg-1",
		timestamp: new Date(),
		body,
		attempts: 1,
		ack,
		retry,
	};
	return { message, ack, retry };
};

/**
 * Same as `buildMessage`, but accepts an untyped `body` so tests can construct
 * malformed messages (missing/wrong-shaped `name`) that don't fit the `JobMessage`
 * shape (e.g. `undefined`, `null`, or a `name` that isn't a string).
 */
const buildMalformedMessage = (body: unknown) => {
	const ack = vi.fn();
	const retry = vi.fn();
	const message: Message<JobMessage> = {
		id: "msg-1",
		timestamp: new Date(),
		body: body as JobMessage,
		attempts: 1,
		ack,
		retry,
	};
	return { message, ack, retry };
};

/** A minimal stub satisfying `MessageBatch<JobMessage>`. */
const buildBatch = (messages: Message<JobMessage>[]): MessageBatch<JobMessage> => ({
	queue: "test-queue",
	messages,
	metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
	ackAll: vi.fn(),
	retryAll: vi.fn(),
});

type GreetJobPayload = { name: string };

class GreetJob extends Job<GreetJobPayload> {
	readonly name = "greet";
	async perform(): Promise<void> {}
}

describe("CloudflareJobQueue", () => {
	test("enqueue calls Queue#send with the { name, payload } shape", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" });

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ name: "greet", payload: { name: "Taro" } });
	});

	test("when delaySeconds is given, passes { delaySeconds } as Queue#send's second argument", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" }, { delaySeconds: 60 });

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			{ name: "greet", payload: { name: "Taro" } },
			{ delaySeconds: 60 },
		);
	});

	test("when delaySeconds is omitted, calls Queue#send with no second argument", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" }, {});

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ name: "greet", payload: { name: "Taro" } });
	});

	test("specifying an invalid delaySeconds throws without calling Queue#send", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await expect(
			new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" }, { delaySeconds: -1 }),
		).rejects.toThrow(/delaySeconds/);
		expect(send).not.toHaveBeenCalled();
	});

	test("specifying a non-integer priority throws without calling Queue#send", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await expect(
			new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" }, { priority: 1.5 }),
		).rejects.toThrow(/priority/);
		expect(send).not.toHaveBeenCalled();
	});

	test("a negative priority is treated as a valid value and calls Queue#send", async () => {
		const { queue, send } = buildQueueStub();
		const job = new GreetJob();

		await new CloudflareJobQueue(queue).enqueue(job, { name: "Taro" }, { priority: -1 });

		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("QueueConsumer", () => {
	test("on successful perform, the message is acked and not retried", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);
		const consumer = new QueueConsumer(registry);

		const { message, ack, retry } = buildMessage({ name: "greet", payload: { name: "Taro" } });
		await consumer.handle(buildBatch([message]));

		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	test("on failed perform, the message is retried, not acked, and the onJobError hook is called", async () => {
		const registry = new JobRegistry();
		class FailingJob extends Job<GreetJobPayload> {
			readonly name = "fail";
			async perform(): Promise<void> {
				throw new Error("transient failure");
			}
		}
		registry.register(new FailingJob());

		const onJobError = vi.fn();
		const consumer = new QueueConsumer(registry, { onJobError });

		const { message, ack, retry } = buildMessage({ name: "fail", payload: { name: "Taro" } });
		await consumer.handle(buildBatch([message]));

		expect(retry).toHaveBeenCalledTimes(1);
		expect(ack).not.toHaveBeenCalled();
		expect(onJobError).toHaveBeenCalledWith("fail", expect.any(Error));
	});

	test("an unknown job name is discarded via ack without retrying, and the onUnknownJob hook is called", async () => {
		const registry = new JobRegistry();
		const onUnknownJob = vi.fn();
		const consumer = new QueueConsumer(registry, { onUnknownJob });

		const { message, ack, retry } = buildMessage({ name: "not_registered", payload: {} });
		await consumer.handle(buildBatch([message]));

		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
		expect(onUnknownJob).toHaveBeenCalledWith("not_registered");
	});

	test.each([
		["undefined body", undefined],
		["null body", null],
		["body with no name", { payload: 1 }],
		["body with a non-string name", { name: 123 }],
	])(
		"a malformed body (%s) is acked without retrying instead of throwing",
		async (_label, body) => {
			const registry = new JobRegistry();
			const onUnknownJob = vi.fn();
			const consumer = new QueueConsumer(registry, { onUnknownJob });

			const { message, ack, retry } = buildMalformedMessage(body);
			await expect(consumer.handle(buildBatch([message]))).resolves.toBeUndefined();

			expect(ack).toHaveBeenCalledTimes(1);
			expect(retry).not.toHaveBeenCalled();
			expect(onUnknownJob).toHaveBeenCalledWith("");
		},
	);

	test("a malformed body earlier in the batch does not abort processing of a valid message later in the batch", async () => {
		const registry = new JobRegistry();
		const job = new GreetJob();
		registry.register(job);
		const onUnknownJob = vi.fn();
		const consumer = new QueueConsumer(registry, { onUnknownJob });

		const { message: malformed, ack: malformedAck } = buildMalformedMessage(undefined);
		const {
			message: valid,
			ack: validAck,
			retry: validRetry,
		} = buildMessage({
			name: "greet",
			payload: { name: "Taro" },
		});

		await consumer.handle(buildBatch([malformed, valid]));

		expect(onUnknownJob).toHaveBeenCalledWith("");
		expect(malformedAck).toHaveBeenCalledTimes(1);
		expect(validAck).toHaveBeenCalledTimes(1);
		expect(validRetry).not.toHaveBeenCalled();
	});
});
