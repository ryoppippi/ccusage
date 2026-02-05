import type { CliInvocation } from './cli-utils.ts';
import { z } from 'zod';
import { createCliInvocation, executeCliCommand, resolveBinaryPath } from './cli-utils.ts';

const kimiModelUsageSchema = z.object({
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	isFallback: z.boolean().optional(),
});

const kimiTotalsSchema = z.object({
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
});

const kimiDailyRowSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(z.string(), kimiModelUsageSchema),
});

const kimiMonthlyRowSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(z.string(), kimiModelUsageSchema),
});

const kimiSessionRowSchema = z.object({
	sessionId: z.string(),
	lastActivity: z.string(),
	sessionFile: z.string(),
	directory: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(z.string(), kimiModelUsageSchema),
});

const kimiDailyResponseSchema = z.object({
	daily: z.array(kimiDailyRowSchema),
	totals: kimiTotalsSchema.nullable(),
});

const kimiMonthlyResponseSchema = z.object({
	monthly: z.array(kimiMonthlyRowSchema),
	totals: kimiTotalsSchema.nullable(),
});

const kimiSessionResponseSchema = z.object({
	sessions: z.array(kimiSessionRowSchema),
	totals: kimiTotalsSchema.nullable(),
});

const kimiWeeklyRowSchema = z.object({
	week: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(z.string(), kimiModelUsageSchema),
});

const kimiWeeklyResponseSchema = z.object({
	weekly: z.array(kimiWeeklyRowSchema),
	totals: kimiTotalsSchema.nullable(),
});

export const kimiParametersShape = {
	since: z.string().optional(),
	until: z.string().optional(),
	timezone: z.string().optional(),
	locale: z.string().optional(),
	shareDir: z.string().optional(),
} as const satisfies Record<string, z.ZodTypeAny>;

export const kimiParametersSchema = z.object(kimiParametersShape);

let cachedKimiInvocation: CliInvocation | null = null;

function getKimiInvocation(): CliInvocation {
	if (cachedKimiInvocation != null) {
		return cachedKimiInvocation;
	}

	const entryPath = resolveBinaryPath('@ccusage/kimi', 'ccusage-kimi');
	cachedKimiInvocation = createCliInvocation(entryPath);
	return cachedKimiInvocation;
}

async function runKimiCliJson(
	command: 'daily' | 'monthly' | 'session' | 'weekly',
	parameters: z.infer<typeof kimiParametersSchema>,
): Promise<string> {
	const { executable, prefixArgs } = getKimiInvocation();
	const cliArgs: string[] = [...prefixArgs, command, '--json'];

	const since = parameters.since;
	if (since != null && since !== '') {
		cliArgs.push('--since', since);
	}
	const until = parameters.until;
	if (until != null && until !== '') {
		cliArgs.push('--until', until);
	}
	const timezone = parameters.timezone;
	if (timezone != null && timezone !== '') {
		cliArgs.push('--timezone', timezone);
	}
	const locale = parameters.locale;
	if (locale != null && locale !== '') {
		cliArgs.push('--locale', locale);
	}

	const env: Record<string, string> = {};
	const shareDir = parameters.shareDir;
	if (shareDir != null && shareDir.trim() !== '') {
		env.KIMI_SHARE_DIR = shareDir;
	}

	return executeCliCommand(executable, cliArgs, env);
}

export async function getKimiDaily(parameters: z.infer<typeof kimiParametersSchema>) {
	const raw = await runKimiCliJson('daily', parameters);
	return kimiDailyResponseSchema.parse(JSON.parse(raw));
}

export async function getKimiMonthly(parameters: z.infer<typeof kimiParametersSchema>) {
	const raw = await runKimiCliJson('monthly', parameters);
	return kimiMonthlyResponseSchema.parse(JSON.parse(raw));
}

export async function getKimiSession(parameters: z.infer<typeof kimiParametersSchema>) {
	const raw = await runKimiCliJson('session', parameters);
	return kimiSessionResponseSchema.parse(JSON.parse(raw));
}

export async function getKimiWeekly(parameters: z.infer<typeof kimiParametersSchema>) {
	const raw = await runKimiCliJson('weekly', parameters);
	return kimiWeeklyResponseSchema.parse(JSON.parse(raw));
}
