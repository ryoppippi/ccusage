import type { TokenUsageDelta } from './_types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';

export function createEmptyUsage(): TokenUsageDelta {
	return {
		inputTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
	};
}

export function addUsage(target: TokenUsageDelta, delta: TokenUsageDelta): void {
	target.inputTokens += delta.inputTokens;
	target.outputTokens += delta.outputTokens;
	target.reasoningTokens += delta.reasoningTokens;
	target.cacheReadTokens += delta.cacheReadTokens;
	target.cacheWriteTokens += delta.cacheWriteTokens;
	target.totalTokens += delta.totalTokens;
}

export { formatCurrency, formatTokens };
