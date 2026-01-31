import type { CliInvocation } from './cli-utils.ts';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import { z } from 'zod';
import { createCliInvocation, executeCliCommand, resolveBinaryPath } from './cli-utils.ts';

const codexModelUsageSchema = z.object({
	inputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	// Legacy field (Codex used `cachedInputTokens` before splitting cache fields)
	cachedInputTokens: z.number().optional(),
	isFallback: z.boolean().optional(),
});

const codexTotalsSchema = z.object({
	inputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	totalCost: z.number(),
});

const codexDailyRowSchema = z.object({
	date: z.string(),
	inputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	totalCost: z.number(),
	models: z.record(z.string(), codexModelUsageSchema),
	// Legacy fields (kept for backward compatibility)
	cachedInputTokens: z.number().optional(),
	costUSD: z.number().optional(),
});

const codexMonthlyRowSchema = z.object({
	month: z.string(),
	inputTokens: z.number(),
	cacheCreationTokens: z.number(),
	cacheReadTokens: z.number(),
	outputTokens: z.number(),
	reasoningOutputTokens: z.number(),
	totalTokens: z.number(),
	totalCost: z.number(),
	models: z.record(z.string(), codexModelUsageSchema),
	// Legacy fields (kept for backward compatibility)
	cachedInputTokens: z.number().optional(),
	costUSD: z.number().optional(),
});

// Response schemas for internal parsing only - not exported
const codexDailyResponseSchema = z.union([
	z.object({
		daily: z.array(codexDailyRowSchema),
		totals: codexTotalsSchema,
	}),
	// Legacy behavior: some versions returned `[]` when filters yielded no rows
	z.array(z.never()),
]);

const codexMonthlyResponseSchema = z.object({
	monthly: z.array(codexMonthlyRowSchema),
	totals: codexTotalsSchema,
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

	const entryPath = resolveBinaryPath('@ccusage/codex', 'ccusage-codex');
	cachedCodexInvocation = createCliInvocation(entryPath);
	return cachedCodexInvocation;
}

async function runCodexCliJson(
	command: 'daily' | 'monthly',
	parameters: z.infer<typeof codexParametersSchema>,
): Promise<string> {
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
	} else if (parameters.offline === false) {
		cliArgs.push('--no-offline');
	}

	return executeCliCommand(executable, cliArgs, {
		// Keep default log level to allow JSON output
	});
}

export async function getCodexDaily(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('daily', parameters);
	const parsed = JSON.parse(raw) as unknown;
	const normalized = codexDailyResponseSchema.parse(parsed);
	if (Array.isArray(normalized)) {
		return {
			daily: [],
			totals: {
				inputTokens: 0,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				outputTokens: 0,
				reasoningOutputTokens: 0,
				totalTokens: 0,
				totalCost: 0,
			},
		};
	}
	return normalized;
}

export async function getCodexMonthly(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('monthly', parameters);
	return codexMonthlyResponseSchema.parse(JSON.parse(raw));
}

if (import.meta.vitest != null) {
	describe('getCodexDaily/getCodexMonthly', () => {
		it('parses empty daily output (no data)', async () => {
			const originalCodexHome = process.env.CODEX_HOME;
			await using fixture = await createFixture({ sessions: {} });
			process.env.CODEX_HOME = fixture.path;
			try {
				const result = await getCodexDaily({ offline: true });
				expect(result).toEqual({
					daily: [],
					totals: {
						inputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						outputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				});
			} finally {
				if (originalCodexHome == null) {
					delete process.env.CODEX_HOME;
				} else {
					process.env.CODEX_HOME = originalCodexHome;
				}
			}
		});

		it('parses empty monthly output (no data)', async () => {
			const originalCodexHome = process.env.CODEX_HOME;
			await using fixture = await createFixture({ sessions: {} });
			process.env.CODEX_HOME = fixture.path;
			try {
				const result = await getCodexMonthly({ offline: true });
				expect(result).toEqual({
					monthly: [],
					totals: {
						inputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						outputTokens: 0,
						reasoningOutputTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				});
			} finally {
				if (originalCodexHome == null) {
					delete process.env.CODEX_HOME;
				} else {
					process.env.CODEX_HOME = originalCodexHome;
				}
			}
		});
	});
}
