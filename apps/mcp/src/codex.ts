import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import spawn, { SubprocessError } from 'nano-spawn';
import { z } from 'zod';

const nodeRequire = createRequire(import.meta.url);

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

type CodexBinField = string | Record<string, string> | undefined;

type CodexInvocation = {
	executable: string;
	prefixArgs: string[];
};

let cachedCodexInvocation: CodexInvocation | null = null;

function getCodexInvocation(): CodexInvocation {
	if (cachedCodexInvocation != null) {
		return cachedCodexInvocation;
	}

	let packageJsonPath: string;
	try {
		packageJsonPath = nodeRequire.resolve('@ccusage/codex/package.json');
	}
	catch (error) {
		throw new Error('Unable to resolve @ccusage/codex. Install the package alongside @ccusage/mcp to enable Codex tools.', { cause: error });
	}

	const codexPackage = nodeRequire('@ccusage/codex/package.json') as { bin?: CodexBinField; publishConfig?: { bin?: CodexBinField } };
	const binField: CodexBinField = codexPackage.bin ?? codexPackage.publishConfig?.bin;

	let binRelative: string | undefined;
	if (typeof binField === 'string') {
		binRelative = binField;
	}
	else if (binField != null && typeof binField === 'object') {
		binRelative = binField['ccusage-codex'] ?? Object.values(binField)[0];
	}

	if (binRelative == null) {
		throw new Error('Unable to locate ccusage-codex binary entry in @ccusage/codex package.json');
	}

	const codexDir = path.dirname(packageJsonPath);
	const entryPath = path.resolve(codexDir, binRelative);

	// Use bun for TypeScript files in development
	if (entryPath.endsWith('.ts')) {
		cachedCodexInvocation = {
			executable: 'bun',
			prefixArgs: [entryPath],
		};
	}
	else {
		// Use node for built JavaScript files in production
		cachedCodexInvocation = {
			executable: process.execPath,
			prefixArgs: [entryPath],
		};
	}
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

	try {
		const result = await spawn(executable, cliArgs, {
			env: {
				...process.env,
				LOG_LEVEL: '0',
				FORCE_COLOR: '0',
			},
		});
		const output = (result.stdout ?? result.output ?? '').trim();
		if (output === '') {
			throw new Error('Codex CLI returned empty output');
		}
		return output;
	}
	catch (error: unknown) {
		if (error instanceof SubprocessError) {
			const message = (error.stderr ?? error.stdout ?? error.output ?? error.message).trim();
			throw new Error(message);
		}
		throw error;
	}
}

export async function getCodexDaily(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('daily', parameters);
	return codexDailyResponseSchema.parse(JSON.parse(raw));
}

export async function getCodexMonthly(parameters: z.infer<typeof codexParametersSchema>) {
	const raw = await runCodexCliJson('monthly', parameters);
	return codexMonthlyResponseSchema.parse(JSON.parse(raw));
}
