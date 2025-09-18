import type { CliInvocation } from './cli-utils.ts';
import { z } from 'zod';
import { createCliInvocation, executeCliCommand, resolveBinaryPath } from './cli-utils.ts';

const codexModelUsageSchema = z.object({
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	isFallback: z.boolean().optional(),
});

const codexTotalsSchema = z.object({
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
});

const codexDailyRowSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(codexModelUsageSchema),
});

const codexMonthlyRowSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	cachedInputTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	costUSD: z.number(),
	models: z.record(codexModelUsageSchema),
});

// Response schemas for internal parsing only - not exported
const codexDailyResponseSchema = z.object({
	daily: z.array(codexDailyRowSchema),
	totals: codexTotalsSchema.nullable(),
});

const codexMonthlyResponseSchema = z.object({
	monthly: z.array(codexMonthlyRowSchema),
	totals: codexTotalsSchema.nullable(),
});

export const codexParametersShape = {
	since: z.string().optional(),
	until: z.string().optional(),
	timezone: z.string().optional(),
	locale: z.string().optional(),
	offline: z.boolean().optional(),
} as const satisfies Record<string, z.ZodTypeAny>;

export const codexParametersSchema = z.object(codexParametersShape);

let cachedCodexInvocation: CliInvocation | null = null;

function getCodexInvocation(): CliInvocation {
	if (cachedCodexInvocation != null) {
		return cachedCodexInvocation;
	}

	const entryPath = resolveBinaryPath('@ccusage/codex');
	cachedCodexInvocation = createCliInvocation(entryPath);
	return cachedCodexInvocation;
}

async function runCodexCliJson(command: 'daily' | 'monthly', parameters: z.infer<typeof codexParametersSchema>): Promise<string> {
	const { executable, prefixArgs } = getCodexInvocation();
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
	if (parameters.offline === true) {
		cliArgs.push('--offline');
	}
	else if (parameters.offline === false) {
		cliArgs.push('--no-offline');
	}

	return executeCliCommand(executable, cliArgs, {
		// Keep default log level to allow JSON output
	});
}

export async function getCodexDaily(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('daily', parameters);
	return codexDailyResponseSchema.parse(JSON.parse(raw));
}

export async function getCodexMonthly(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('monthly', parameters);
	return codexMonthlyResponseSchema.parse(JSON.parse(raw));
}
