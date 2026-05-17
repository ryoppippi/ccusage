import * as v from 'valibot';

export const gooseSessionRowSchema = v.object({
	id: v.string(),
	model_config_json: v.nullish(v.string()),
	provider_name: v.nullish(v.string()),
	created_at: v.union([v.string(), v.number()]),
	total_tokens: v.nullish(v.number()),
	input_tokens: v.nullish(v.number()),
	output_tokens: v.nullish(v.number()),
	accumulated_total_tokens: v.nullish(v.number()),
	accumulated_input_tokens: v.nullish(v.number()),
	accumulated_output_tokens: v.nullish(v.number()),
});

const gooseModelConfigSchema = v.object({
	model_name: v.string(),
});

export type GooseSessionRow = v.InferOutput<typeof gooseSessionRowSchema>;

export type GooseUsageEntry = {
	timestamp: Date;
	sessionID: string;
	model: string;
	providerID: string;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	totalTokens: number;
};

export function parseGooseModelConfig(value: string): string | null {
	const parsedJson = (() => {
		try {
			return JSON.parse(value) as unknown;
		} catch {
			return null;
		}
	})();
	const parsed = v.safeParse(gooseModelConfigSchema, parsedJson);
	if (!parsed.success) {
		return null;
	}
	const model = parsed.output.model_name.trim();
	return model === '' ? null : model;
}

if (import.meta.vitest != null) {
	describe('parseGooseModelConfig', () => {
		it('reads a non-empty model name', () => {
			expect(parseGooseModelConfig('{"model_name":"claude-sonnet-4-20250514"}')).toBe(
				'claude-sonnet-4-20250514',
			);
		});

		it('rejects missing, empty, and invalid model config', () => {
			expect(parseGooseModelConfig('{"model_name":"  "}')).toBeNull();
			expect(parseGooseModelConfig('{}')).toBeNull();
			expect(parseGooseModelConfig('not json')).toBeNull();
		});
	});
}
