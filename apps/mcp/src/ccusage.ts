import type { CliInvocation } from './cli-utils.ts';
import { z } from 'zod';
import { createCliInvocation, executeCliCommand, resolveBinaryPath } from './cli-utils.ts';
import { DATE_FILTER_REGEX } from './consts.ts';

export const filterDateSchema = z.string()
	.regex(DATE_FILTER_REGEX, 'Date must be in YYYYMMDD format');

export const ccusageParametersShape = {
	since: filterDateSchema.optional(),
	until: filterDateSchema.optional(),
	mode: z.enum(['auto', 'calculate', 'display']).default('auto').optional(),
	timezone: z.string().optional(),
	locale: z.string().optional(),
} as const satisfies Record<string, z.ZodTypeAny>;

export const ccusageParametersSchema = z.object(ccusageParametersShape);

let cachedCcusageInvocation: CliInvocation | null = null;

function getCcusageInvocation(): CliInvocation {
	if (cachedCcusageInvocation != null) {
		return cachedCcusageInvocation;
	}

	const entryPath = resolveBinaryPath('better-ccusage', 'better-ccusage');
	cachedCcusageInvocation = createCliInvocation(entryPath);
	return cachedCcusageInvocation;
}

async function runCcusageCliJson(
	command: 'daily' | 'monthly' | 'session' | 'blocks',
	parameters: z.infer<typeof ccusageParametersSchema>,
	claudePath: string,
): Promise<string> {
	const { executable, prefixArgs } = getCcusageInvocation();
	const cliArgs: string[] = [...prefixArgs, command, '--json'];

	const since = parameters.since;
	if (since != null && since !== '') {
		cliArgs.push('--since', since);
	}
	const until = parameters.until;
	if (until != null && until !== '') {
		cliArgs.push('--until', until);
	}
	const mode = parameters.mode;
	if (mode != null && mode !== 'auto') {
		cliArgs.push('--mode', mode);
	}
	const timezone = parameters.timezone;
	if (timezone != null && timezone !== '') {
		cliArgs.push('--timezone', timezone);
	}
	const locale = parameters.locale;
	if (locale != null && locale !== '') {
		cliArgs.push('--locale', locale);
	}

	return executeCliCommand(executable, cliArgs, {
		// Set Claude path for ccusage
		CLAUDE_CONFIG_DIR: claudePath,
		// Force offline mode to prevent network calls to LiteLLM
		OFFLINE: 'true',
	});
}

export async function getCcusageDaily(parameters: z.infer<typeof ccusageParametersSchema>, claudePath: string): Promise<unknown> {
	try {
		const raw = await runCcusageCliJson('daily', parameters, claudePath);
		const parsed = JSON.parse(raw) as unknown;
		// If the parsed result is an empty array, convert to expected structure
		if (Array.isArray(parsed) && parsed.length === 0) {
			return { daily: [], totals: {} };
		}
		return parsed;
	}
	catch {
		// Return empty result on error
		return { daily: [], totals: {} };
	}
}

export async function getCcusageMonthly(parameters: z.infer<typeof ccusageParametersSchema>, claudePath: string): Promise<unknown> {
	try {
		const raw = await runCcusageCliJson('monthly', parameters, claudePath);
		const parsed = JSON.parse(raw) as unknown;
		// If the parsed result is an empty array, convert to expected structure
		if (Array.isArray(parsed) && parsed.length === 0) {
			return { monthly: [], totals: {} };
		}
		return parsed;
	}
	catch {
		// Return empty result on error
		return { monthly: [], totals: {} };
	}
}

export async function getCcusageSession(parameters: z.infer<typeof ccusageParametersSchema>, claudePath: string): Promise<unknown> {
	try {
		const raw = await runCcusageCliJson('session', parameters, claudePath);
		const parsed = JSON.parse(raw) as unknown;
		// If the parsed result is an empty array, convert to expected structure
		if (Array.isArray(parsed) && parsed.length === 0) {
			return { sessions: [], totals: {} };
		}
		return parsed;
	}
	catch {
		// Return empty result on error
		return { sessions: [], totals: {} };
	}
}

export async function getCcusageBlocks(parameters: z.infer<typeof ccusageParametersSchema>, claudePath: string): Promise<unknown> {
	try {
		const raw = await runCcusageCliJson('blocks', parameters, claudePath);
		const parsed = JSON.parse(raw) as unknown;
		// If the parsed result is an empty array, convert to expected structure
		if (Array.isArray(parsed) && parsed.length === 0) {
			return { blocks: [] };
		}
		return parsed;
	}
	catch {
		// Return empty result on error
		return { blocks: [] };
	}
}
