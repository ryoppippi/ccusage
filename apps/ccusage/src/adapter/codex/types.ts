import type { IndexedWorkerData, IndexedWorkerResultsMessage } from '@ccusage/internal/workers';
import type { AgentUsageRow } from '../types.ts';

export type RawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

export type ParsedTokenCountLine = {
	timestamp: string;
	lastUsage: RawUsage | null;
	totalUsage: RawUsage | null;
	model: string | undefined;
};

export type TokenUsageEvent = {
	timestamp: string;
	sessionId: string;
	model?: string;
	isFallbackModel?: boolean;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
};

export type CodexModelUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
	totalTokens: number;
	isFallback?: boolean;
};

export type CodexGroup = {
	row: AgentUsageRow;
	models: Map<string, CodexModelUsage>;
	reasoningOutputTokens: number;
	lastActivity: string;
};

export type CodexSpeed = 'standard' | 'fast';

export type CodexWorkerData = IndexedWorkerData<'ccusage:codex-worker', string> & {
	directoryPath: string;
};

export type EncodedTokenUsageEvents = {
	timestamps: string[];
	sessionIds: string[];
	models: string[];
	modelIndexes: Int32Array;
	numbers: Float64Array;
	flags: Uint8Array;
};

export type CodexWorkerResponse = IndexedWorkerResultsMessage<EncodedTokenUsageEvents>;

export type CodexReportRow =
	| {
			date: string;
			inputTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningOutputTokens: number;
			totalTokens: number;
			costUSD: number;
			models: Record<string, CodexModelUsage>;
	  }
	| {
			month: string;
			inputTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningOutputTokens: number;
			totalTokens: number;
			costUSD: number;
			models: Record<string, CodexModelUsage>;
	  }
	| {
			sessionId: string;
			lastActivity: string;
			sessionFile: string;
			directory: string;
			inputTokens: number;
			cachedInputTokens: number;
			outputTokens: number;
			reasoningOutputTokens: number;
			totalTokens: number;
			costUSD: number;
			models: Record<string, CodexModelUsage>;
	  };
