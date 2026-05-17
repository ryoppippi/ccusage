import path from 'node:path';
import * as v from 'valibot';

const openClawUsageSchema = v.object({
	input: v.optional(v.number()),
	output: v.optional(v.number()),
	cacheRead: v.optional(v.number()),
	cacheWrite: v.optional(v.number()),
	totalTokens: v.optional(v.number()),
	cost: v.optional(
		v.object({
			total: v.optional(v.number()),
		}),
	),
});

const openClawMessageSchema = v.object({
	role: v.optional(v.string()),
	model: v.optional(v.string()),
	modelId: v.optional(v.string()),
	provider: v.optional(v.string()),
	usage: v.optional(openClawUsageSchema),
	timestamp: v.optional(v.union([v.number(), v.string()])),
});

export const openClawEntrySchema = v.object({
	type: v.optional(v.string()),
	customType: v.optional(v.string()),
	provider: v.optional(v.string()),
	modelId: v.optional(v.string()),
	model: v.optional(v.string()),
	timestamp: v.optional(v.union([v.number(), v.string()])),
	message: v.optional(openClawMessageSchema),
	data: v.optional(
		v.object({
			provider: v.optional(v.string()),
			modelId: v.optional(v.string()),
			model: v.optional(v.string()),
		}),
	),
});

export type OpenClawEntry = v.InferOutput<typeof openClawEntrySchema>;
export type OpenClawMessage = v.InferOutput<typeof openClawMessageSchema>;

export type OpenClawUsageEntry = {
	timestamp: string;
	sessionId: string;
	model: string;
	provider: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	tokenTotal: number;
	cost: number;
};

export function isModelChangeEntry(entry: OpenClawEntry): boolean {
	if (entry.type === 'model_change') {
		return true;
	}
	return entry.type === 'custom' && entry.customType === 'model-snapshot';
}

export function isAssistantMessageEntry(entry: OpenClawEntry): boolean {
	return (
		entry.type === 'message' &&
		entry.message != null &&
		entry.message.role === 'assistant' &&
		entry.message.usage != null
	);
}

export function getModelFromChange(entry: OpenClawEntry): {
	model: string | undefined;
	provider: string | undefined;
} {
	const source = entry.data ?? entry;
	return {
		model: source.modelId ?? source.model,
		provider: source.provider,
	};
}

export function extractOpenClawSessionId(filePath: string): string {
	const filename = path.basename(filePath);
	const jsonlIndex = filename.indexOf('.jsonl');
	const stem = jsonlIndex === -1 ? filename : filename.slice(0, jsonlIndex);
	return stem === '' ? filename : stem;
}

export function toIsoTimestamp(value: number | string | undefined, fallback: string): string {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString();
		}
	}
	if (typeof value === 'string' && value !== '') {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return date.toISOString();
		}
	}
	return fallback;
}

if (import.meta.vitest != null) {
	describe('openclaw schema helpers', () => {
		it('detects model_change entries', () => {
			expect(
				isModelChangeEntry({ type: 'model_change', modelId: 'gpt-5.2', provider: 'openai' }),
			).toBe(true);
			expect(
				isModelChangeEntry({
					type: 'custom',
					customType: 'model-snapshot',
					data: { modelId: 'gpt-5.2', provider: 'openai' },
				}),
			).toBe(true);
			expect(isModelChangeEntry({ type: 'custom' })).toBe(false);
		});

		it('detects assistant message entries with usage', () => {
			expect(
				isAssistantMessageEntry({
					type: 'message',
					message: { role: 'assistant', usage: { input: 1, output: 1 } },
				}),
			).toBe(true);
			expect(
				isAssistantMessageEntry({
					type: 'message',
					message: { role: 'user', usage: { input: 1, output: 1 } },
				}),
			).toBe(false);
			expect(isAssistantMessageEntry({ type: 'message', message: { role: 'assistant' } })).toBe(
				false,
			);
		});

		it('reads model and provider from data envelope or top-level fields', () => {
			expect(
				getModelFromChange({ type: 'model_change', modelId: 'gpt-5.2', provider: 'openai' }),
			).toEqual({ model: 'gpt-5.2', provider: 'openai' });
			expect(
				getModelFromChange({
					type: 'custom',
					customType: 'model-snapshot',
					data: { model: 'gpt-5.2', provider: 'anthropic' },
				}),
			).toEqual({ model: 'gpt-5.2', provider: 'anthropic' });
		});

		it('extracts session id from regular and archived jsonl file names', () => {
			expect(extractOpenClawSessionId('/sessions/abc.jsonl')).toBe('abc');
			expect(extractOpenClawSessionId('/sessions/abc.jsonl.deleted.1700000000000')).toBe('abc');
			expect(extractOpenClawSessionId('/sessions/abc.jsonl.reset.2026-03-20T06-34-44.520Z')).toBe(
				'abc',
			);
		});

		it('converts numeric and string timestamps, falling back when invalid', () => {
			expect(toIsoTimestamp(1769753935279, '2026-05-17T00:00:00.000Z')).toBe(
				'2026-01-30T06:18:55.279Z',
			);
			expect(toIsoTimestamp('2026-04-22T01:02:03.000Z', '2026-05-17T00:00:00.000Z')).toBe(
				'2026-04-22T01:02:03.000Z',
			);
			expect(toIsoTimestamp(undefined, '2026-05-17T00:00:00.000Z')).toBe(
				'2026-05-17T00:00:00.000Z',
			);
		});
	});
}
