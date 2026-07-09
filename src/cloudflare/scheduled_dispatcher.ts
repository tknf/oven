/**
 * Provides a `dispatch` method, built from a cron-expression-to-handler map, that can be
 * called from a Workers `scheduled(controller, env, ctx)` handler.
 *
 * Looks up the map by `controller.cron` (`ScheduledController`, which has `readonly
 * scheduledTime: number` / `readonly cron: string`) and runs the matching handler with
 * `scheduledTime`.
 *
 * Throws if no cron expression in the map matches (never silently ignored), so that a
 * configuration mistake — a Cron Trigger set up in `wrangler.jsonc` but never registered in
 * this map — surfaces at runtime instead of being hidden.
 */
export type ScheduledHandler = (scheduledTime: number) => Promise<void>;

/**
 * Holds `handlers` (a cron-expression-to-handler map) and provides a `dispatch` method that
 * takes a `controller`.
 */
export class ScheduledDispatcher {
	constructor(private readonly handlers: Readonly<Record<string, ScheduledHandler>>) {}

	/**
	 * Dispatches `controller` to the matching handler by cron expression.
	 * An arrow-function class field since it may be passed by reference to a Workers
	 * scheduled handler.
	 *
	 * @throws {Error} If no handler is registered for `controller.cron`.
	 */
	readonly dispatch = async (controller: ScheduledController): Promise<void> => {
		const handler = this.handlers[controller.cron];
		if (!handler) {
			throw new Error(`No handler registered for cron expression "${controller.cron}"`);
		}

		await handler(controller.scheduledTime);
	};
}
