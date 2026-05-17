import path from 'node:path';
import * as v from 'valibot';
import { isoTimestampSchema } from '../../types.ts';

const piAgentUsageSchema = v.object({
	input: v.number(),
	output: v.number(),
	cacheRead: v.optional(v.number()),
	cacheWrite: v.optional(v.number()),
	totalTokens: v.optional(v.number()),
	cost: v.optional(
		v.object({
			total: v.optional(v.number()),
		}),
	),
});

export const piAgentMessageSchema = v.object({
	type: v.optional(v.string()),
	timestamp: isoTimestampSchema,
	message: v.object({
		role: v.optional(v.string()),
		model: v.optional(v.string()),
		usage: v.optional(piAgentUsageSchema),
	}),
});

export type PiAgentMessage = v.InferOutput<typeof piAgentMessageSchema>;

export type PiUsageEntry = {
	timestamp: string;
	model: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
	project: string;
	sessionId: string;
	tokenTotal: number;
};

export function isPiAgentUsageEntry(data: PiAgentMessage): boolean {
	const isMessage = data.type == null || data.type === 'message';
	return (
		isMessage &&
		data.message.role === 'assistant' &&
		data.message.usage != null &&
		typeof data.message.usage.input === 'number' &&
		typeof data.message.usage.output === 'number'
	);
}

export function extractPiAgentSessionId(filePath: string): string {
	const filename = path.basename(filePath, '.jsonl');
	const index = filename.indexOf('_');
	return index === -1 ? filename : filename.slice(index + 1);
}

export function extractPiAgentProject(filePath: string): string {
	const normalizedPath = filePath.replace(/[/\\]/g, path.sep);
	const segments = normalizedPath.split(path.sep);
	const sessionsIndex = segments.findIndex((segment) => segment === 'sessions');
	if (sessionsIndex === -1 || sessionsIndex + 1 >= segments.length) {
		return 'unknown';
	}
	return segments[sessionsIndex + 1] ?? 'unknown';
}

export function transformPiAgentUsage(data: PiAgentMessage): {
	model: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
	tokenTotal: number;
} | null {
	if (!isPiAgentUsageEntry(data)) {
		return null;
	}

	const usage = data.message.usage!;
	const cacheCreationTokens = usage.cacheWrite ?? 0;
	const cacheReadTokens = usage.cacheRead ?? 0;
	const tokenTotal =
		usage.totalTokens ?? usage.input + usage.output + cacheReadTokens + cacheCreationTokens;

	return {
		model: data.message.model == null ? undefined : `[pi] ${data.message.model}`,
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheCreationTokens,
		cacheReadTokens,
		cost: usage.cost?.total ?? 0,
		tokenTotal,
	};
}
