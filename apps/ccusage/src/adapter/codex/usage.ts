import type { CodexModelUsage, TokenUsageEvent } from './types.ts';

export function addCodexUsage(target: CodexModelUsage, event: TokenUsageEvent): void {
	target.inputTokens += event.inputTokens;
	target.cachedInputTokens += event.cachedInputTokens;
	target.outputTokens += event.outputTokens;
	target.reasoningOutputTokens += event.reasoningOutputTokens;
	target.totalTokens += event.totalTokens;
}

export function createCodexUsage(): CodexModelUsage {
	return {
		inputTokens: 0,
		cachedInputTokens: 0,
		outputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
		isFallback: false,
	};
}
