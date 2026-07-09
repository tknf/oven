/**
 * View-layer duration (seconds) formatting helpers.
 */

/**
 * Converts a duration in seconds to a clock display (`H:MM:SS`, or `M:SS`
 * when under an hour). Intended for "read as a clock" displays such as a
 * player's playback position or total duration. Negative or non-finite
 * values are treated as `0` (a fail-safe so an invalid playback position
 * doesn't throw and break the screen).
 */
export const formatClockDuration = (totalSeconds: number): string => {
	const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const seconds = Math.floor(safeSeconds % 60);
	const pad = (value: number) => String(value).padStart(2, "0");

	return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
};

/**
 * Converts a duration in seconds to a Japanese "◯時間◯分" worded format
 * (minutes truncated; under 60 seconds renders as "1分未満"; under an hour
 * renders as "◯分" only). Intended for approximate display in list/detail
 * screens (a different use case from `formatClockDuration`'s clock display).
 *
 * **Why this bypasses the i18n catalog (`i18n.ts`)**: the i18n catalog's
 * scope is limited to cataloging messages the framework itself emits (error
 * pages, future validation copy, etc.). A general-purpose formatter called by
 * arbitrary app screens is out of that scope. This function's output is app
 * content, not a framework message, so it is hardcoded in Japanese rather than
 * routed through the i18n catalog (the `Ja` suffix makes this explicit, and if
 * multilingual support becomes necessary, the plan is to add a separate
 * function, or consider switching to a web-standard, locale-aware API such as
 * `Intl.DurationFormat`).
 */
export const formatWordedDurationJa = (totalSeconds: number): string => {
	const safeSeconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? totalSeconds : 0;

	if (safeSeconds < 60) {
		return "1分未満";
	}

	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);

	return hours > 0 ? `${hours}時間${minutes}分` : `${minutes}分`;
};
