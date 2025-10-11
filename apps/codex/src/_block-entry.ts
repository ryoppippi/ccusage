import type { TokenUsageEvent } from './_types.ts';

export type CodexLoadedUsageEntry = {
	timestamp: Date;
	sessionId: string;
	model: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cachedInputTokens: number;
		reasoningOutputTokens: number;
		totalTokens: number;
	};
	costUSD: number;
	isFallbackModel?: boolean;
};

export function convertEventsToBlockEntries(events: TokenUsageEvent[]): CodexLoadedUsageEntry[] {
	return events
		.flatMap((event) => {
			const model = event.model?.trim();
			if (model == null || model === '') {
				return [];
			}

			const inputTokens = Math.max(event.inputTokens, 0);
			const cachedInputTokens = Math.max(Math.min(event.cachedInputTokens, inputTokens), 0);
			const outputTokens = Math.max(event.outputTokens, 0);
			const reasoningOutputTokens = Math.max(event.reasoningOutputTokens, 0);
			const totalTokens = Math.max(event.totalTokens, 0);

			return [{
				timestamp: new Date(event.timestamp),
				sessionId: event.sessionId,
				model,
				usage: {
					inputTokens,
					outputTokens,
					cachedInputTokens,
					reasoningOutputTokens,
					totalTokens,
				},
				costUSD: 0,
				isFallbackModel: event.isFallbackModel,
			} satisfies CodexLoadedUsageEntry];
		})
		.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

if (import.meta.vitest != null) {
	describe('convertEventsToBlockEntries', () => {
		const baseEvent: TokenUsageEvent = {
			sessionId: 'session-1',
			timestamp: '2025-10-05T00:00:00.000Z',
			model: 'gpt-5',
			inputTokens: 100,
			cachedInputTokens: 50,
			outputTokens: 30,
			reasoningOutputTokens: 5,
			totalTokens: 130,
		};

		it('converts timestamps to Date objects and sorts ascending', () => {
			const events: TokenUsageEvent[] = [
				{ ...baseEvent, timestamp: '2025-10-05T02:00:00.000Z', inputTokens: -10 },
				{ ...baseEvent, timestamp: '2025-10-05T01:00:00.000Z', cachedInputTokens: 120 },
			];

			const entries = convertEventsToBlockEntries(events);
			expect(entries).toHaveLength(2);
			expect(entries[0]?.timestamp.toISOString()).toBe('2025-10-05T01:00:00.000Z');
			expect(entries[0]?.usage.inputTokens).toBe(100);
			expect(entries[0]?.usage.cachedInputTokens).toBe(100);
			expect(entries[1]?.usage.inputTokens).toBe(0);
			expect(entries[1]?.usage.cachedInputTokens).toBe(0);
		});

		it('filters out events without model names', () => {
			const events: TokenUsageEvent[] = [
				baseEvent,
				{ ...baseEvent, timestamp: '2025-10-05T01:00:00.000Z', model: undefined },
				{ ...baseEvent, timestamp: '2025-10-05T01:30:00.000Z', model: '' },
			];

			const entries = convertEventsToBlockEntries(events);
			expect(entries).toHaveLength(1);
			expect(entries[0]?.model).toBe('gpt-5');
		});
	});
}
