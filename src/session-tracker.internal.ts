/**
 * Session tracker to manage session start values for summary calculations
 */

/**
 * Tracks session start values for summary calculations
 */
export type SessionTracker = {
	startTokens: number;
	startCost: number;
	setStartValues: (tokens: number, cost: number) => void;
};

/**
 * Creates a session tracker to manage session start values
 * @returns Session tracker object
 */
export function createSessionTracker(): SessionTracker {
	let startTokens = 0;
	let startCost = 0;

	return {
		get startTokens() {
			return startTokens;
		},
		get startCost() {
			return startCost;
		},
		setStartValues(tokens: number, cost: number) {
			// Only set values once at the beginning of the session
			if (startTokens === 0 && startCost === 0) {
				startTokens = tokens;
				startCost = cost;
			}
		},
	};
}
