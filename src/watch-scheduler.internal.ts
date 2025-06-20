/**
 * Creates an adaptive scheduler for updating the display at variable intervals
 * @param updateFunction - The function to call on each update
 * @param intervalRef - Reference to the current interval duration
 * @param intervalRef.current - The current interval duration in milliseconds
 * @returns Object with start and stop methods
 */
export function createAdaptiveScheduler(
	updateFunction: () => Promise<void>,
	intervalRef: { current: number },
): {
		start: () => void;
		stop: () => void;
		intervalId: { current: NodeJS.Timeout | null };
	} {
	const intervalId = { current: null as NodeJS.Timeout | null };

	const scheduleNext = (): void => {
		intervalId.current = setTimeout(() => {
			updateFunction().then(() => {
				scheduleNext();
			}).catch((error: unknown) => {
				console.error('Update display error:', error);
			});
		}, intervalRef.current);
	};

	return {
		start: () => {
			scheduleNext();
		},
		stop: () => {
			if (intervalId.current != null) {
				clearTimeout(intervalId.current);
				intervalId.current = null;
			}
		},
		intervalId,
	};
}
