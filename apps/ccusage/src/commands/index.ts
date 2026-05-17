import type { Args, Command } from 'gunshi';
import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../../package.json';
import { loadConfig, mergeConfigWithArgs } from '../config-loader-tokens.ts';
import { sharedArgs } from '../shared-args.ts';
import { createAgentCommand } from './agent.ts';
import { allDailyCommand, allMonthlyCommand, allSessionCommand, allWeeklyCommand } from './all.ts';
import { blocksCommand } from './blocks.ts';
import { codexDailyCommand, codexMonthlyCommand, codexSessionCommand } from './codex.ts';
import { dailyCommand } from './daily.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { statuslineCommand } from './statusline.ts';
import { weeklyCommand } from './weekly.ts';

// Re-export all commands for easy importing
export {
	blocksCommand,
	dailyCommand,
	monthlyCommand,
	sessionCommand,
	statuslineCommand,
	weeklyCommand,
};

function withCommandName<T extends { name?: string }>(command: T, commandName: string): T {
	return { ...command, name: commandName };
}

function withCcusageConfig<const TArgs extends Args>(
	command: Command<TArgs>,
	commandName: string,
): Command<Args> {
	const args = {
		...(command.args ?? {}),
		config: sharedArgs.config,
	} satisfies Args;

	return {
		name: commandName,
		description: command.description,
		args,
		toKebab: command.toKebab,
		async run(ctx) {
			const values = ctx.values as Record<string, unknown>;
			const configPath = typeof values.config === 'string' ? values.config : undefined;
			const debug = typeof values.debug === 'boolean' ? values.debug : false;
			const config = loadConfig(configPath, debug);
			const mergedValues = mergeConfigWithArgs(
				{
					values,
					tokens: ctx.tokens,
					name: commandName,
				},
				config,
				debug,
			);
			await command.run?.({
				...ctx,
				values: mergedValues,
			} as Parameters<NonNullable<Command<TArgs>['run']>>[0]);
		},
	};
}

const opencodeDailyCommand = createAgentCommand(
	'opencode',
	'daily',
	'Show OpenCode token usage grouped by day',
);
const opencodeWeeklyCommand = createAgentCommand(
	'opencode',
	'weekly',
	'Show OpenCode token usage grouped by week',
);
const opencodeMonthlyCommand = createAgentCommand(
	'opencode',
	'monthly',
	'Show OpenCode token usage grouped by month',
);
const opencodeSessionCommand = createAgentCommand(
	'opencode',
	'session',
	'Show OpenCode token usage grouped by session',
);
const ampDailyCommand = createAgentCommand('amp', 'daily', 'Show Amp token usage grouped by day');
const ampMonthlyCommand = createAgentCommand(
	'amp',
	'monthly',
	'Show Amp token usage grouped by month',
);
const ampSessionCommand = createAgentCommand(
	'amp',
	'session',
	'Show Amp token usage grouped by session',
);
const piDailyCommand = createAgentCommand('pi', 'daily', 'Show pi-agent usage grouped by date');
const piMonthlyCommand = createAgentCommand(
	'pi',
	'monthly',
	'Show pi-agent usage grouped by month',
);
const piSessionCommand = createAgentCommand(
	'pi',
	'session',
	'Show pi-agent usage grouped by session',
);

/**
 * Command entries as tuple array
 */
export const subCommandUnion = [
	['daily', allDailyCommand],
	['monthly', allMonthlyCommand],
	['weekly', allWeeklyCommand],
	['session', allSessionCommand],
	['blocks', blocksCommand],
	['statusline', statuslineCommand],
	['claude:daily', withCommandName(dailyCommand, 'claude daily')],
	['claude:monthly', withCommandName(monthlyCommand, 'claude monthly')],
	['claude:weekly', withCommandName(weeklyCommand, 'claude weekly')],
	['claude:session', withCommandName(sessionCommand, 'claude session')],
	['claude:blocks', withCommandName(blocksCommand, 'claude blocks')],
	['claude:statusline', withCommandName(statuslineCommand, 'claude statusline')],
	['codex:daily', withCcusageConfig(codexDailyCommand, 'codex daily')],
	['codex:monthly', withCcusageConfig(codexMonthlyCommand, 'codex monthly')],
	['codex:session', withCcusageConfig(codexSessionCommand, 'codex session')],
	['opencode:daily', withCcusageConfig(opencodeDailyCommand, 'opencode daily')],
	['opencode:weekly', withCcusageConfig(opencodeWeeklyCommand, 'opencode weekly')],
	['opencode:monthly', withCcusageConfig(opencodeMonthlyCommand, 'opencode monthly')],
	['opencode:session', withCcusageConfig(opencodeSessionCommand, 'opencode session')],
	['amp:daily', withCcusageConfig(ampDailyCommand, 'amp daily')],
	['amp:monthly', withCcusageConfig(ampMonthlyCommand, 'amp monthly')],
	['amp:session', withCcusageConfig(ampSessionCommand, 'amp session')],
	['pi:daily', withCcusageConfig(piDailyCommand, 'pi daily')],
	['pi:monthly', withCcusageConfig(piMonthlyCommand, 'pi monthly')],
	['pi:session', withCcusageConfig(piSessionCommand, 'pi session')],
] as const;

/**
 * Available command names extracted from union
 */
export type CommandName = (typeof subCommandUnion)[number][0];

/**
 * Map of available CLI subcommands
 */
const subCommands = new Map();
for (const [name, command] of subCommandUnion) {
	subCommands.set(name, command);
}

/**
 * Default command when no subcommand is specified (defaults to daily)
 */
const mainCommand = allDailyCommand;

const agentCommands = new Set(['claude', 'codex', 'opencode', 'amp', 'pi']);
const agentReports = new Set(['daily', 'weekly', 'monthly', 'session', 'blocks', 'statusline']);
const agentReportCapabilities = new Map<string, Set<string>>([
	['claude', new Set(['daily', 'weekly', 'monthly', 'session', 'blocks', 'statusline'])],
	['codex', new Set(['daily', 'monthly', 'session'])],
	['opencode', new Set(['daily', 'weekly', 'monthly', 'session'])],
	['amp', new Set(['daily', 'monthly', 'session'])],
	['pi', new Set(['daily', 'monthly', 'session'])],
]);
const agentDisplayNames = new Map([
	['claude', 'Claude Code'],
	['codex', 'Codex'],
	['opencode', 'OpenCode'],
	['amp', 'Amp'],
	['pi', 'pi-agent'],
]);
const reportFlagAliases = new Set([
	'--daily',
	'--weekly',
	'--monthly',
	'--session',
	'--blocks',
	'--statusline',
]);
const agentFilterOptions = new Set(['--agent', '-a']);

export function normalizeAgentCommandArgs(args: string[]): string[] {
	const [agent, report, ...rest] = args;
	if (agent == null || !agentCommands.has(agent)) {
		return args;
	}

	if (report != null && agentReports.has(report)) {
		return [`${agent}:${report}`, ...rest];
	}

	return [`${agent}:daily`, ...args.slice(1)];
}

export function getReportFlagAliasError(args: string[]): string | undefined {
	const reportFlag = args.find((arg) => reportFlagAliases.has(arg));
	if (reportFlag != null) {
		return `Report flags like ${reportFlag} are not supported. Use "ccusage ${reportFlag.slice(2)}" instead.`;
	}
	return undefined;
}

export function getAgentFilterOptionError(args: string[]): string | undefined {
	const agentFilterOption = args.find((arg) => {
		if (agentFilterOptions.has(arg)) {
			return true;
		}
		return arg.startsWith('--agent=') || arg.startsWith('-a=');
	});
	if (agentFilterOption == null) {
		return undefined;
	}
	return `Agent filters like ${agentFilterOption} are not supported. Use "ccusage <agent> <report>", for example "ccusage codex daily".`;
}

export function getUnsupportedAgentReportError(args: string[]): string | undefined {
	const [agent, report] = args;
	if (agent == null || report == null || !agentCommands.has(agent) || !agentReports.has(report)) {
		return undefined;
	}

	const supportedReports = agentReportCapabilities.get(agent);
	if (supportedReports?.has(report) === true) {
		return undefined;
	}

	const agentDisplayName = agentDisplayNames.get(agent) ?? agent;
	if (report === 'blocks' || report === 'statusline') {
		return `The "${report}" report is only available for Claude Code usage.\nUse "ccusage ${agent} daily" for ${agentDisplayName} usage reports.`;
	}

	return `The "${report}" report is not available for ${agentDisplayName} usage.\nUse "ccusage ${agent} daily" for ${agentDisplayName} usage reports.`;
}

export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage') {
		args = args.slice(1);
	}
	const reportFlagAliasError = getReportFlagAliasError(args);
	if (reportFlagAliasError != null) {
		process.stderr.write(`${reportFlagAliasError}\n`);
		process.exitCode = 1;
		return;
	}
	const agentFilterOptionError = getAgentFilterOptionError(args);
	if (agentFilterOptionError != null) {
		process.stderr.write(`${agentFilterOptionError}\n`);
		process.exitCode = 1;
		return;
	}
	const unsupportedAgentReportError = getUnsupportedAgentReportError(args);
	if (unsupportedAgentReportError != null) {
		process.stderr.write(`${unsupportedAgentReportError}\n`);
		process.exitCode = 1;
		return;
	}
	args = normalizeAgentCommandArgs(args);

	await cli(args, mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}

if (import.meta.vitest != null) {
	describe('normalizeAgentCommandArgs', () => {
		it('maps an agent report to a flat Gunshi subcommand', () => {
			expect(normalizeAgentCommandArgs(['codex', 'monthly', '--speed', 'fast'])).toEqual([
				'codex:monthly',
				'--speed',
				'fast',
			]);
		});

		it('uses daily as the default report for an agent namespace', () => {
			expect(normalizeAgentCommandArgs(['opencode', '--json'])).toEqual([
				'opencode:daily',
				'--json',
			]);
		});

		it('leaves top-level reports unchanged', () => {
			expect(normalizeAgentCommandArgs(['daily', '--json'])).toEqual(['daily', '--json']);
		});
	});

	describe('getReportFlagAliasError', () => {
		it('rejects report mode flags', () => {
			expect(getReportFlagAliasError(['--daily'])).toBe(
				'Report flags like --daily are not supported. Use "ccusage daily" instead.',
			);
		});
	});

	describe('getAgentFilterOptionError', () => {
		it('rejects agent filter options', () => {
			expect(getAgentFilterOptionError(['daily', '--agent', 'codex'])).toBe(
				'Agent filters like --agent are not supported. Use "ccusage <agent> <report>", for example "ccusage codex daily".',
			);
			expect(getAgentFilterOptionError(['daily', '-a=codex'])).toBe(
				'Agent filters like -a=codex are not supported. Use "ccusage <agent> <report>", for example "ccusage codex daily".',
			);
		});
	});

	describe('getUnsupportedAgentReportError', () => {
		it('rejects Claude-only reports for other agents', () => {
			expect(getUnsupportedAgentReportError(['codex', 'blocks'])).toBe(
				'The "blocks" report is only available for Claude Code usage.\nUse "ccusage codex daily" for Codex usage reports.',
			);
		});

		it('rejects reports that an agent does not implement', () => {
			expect(getUnsupportedAgentReportError(['amp', 'weekly'])).toBe(
				'The "weekly" report is not available for Amp usage.\nUse "ccusage amp daily" for Amp usage reports.',
			);
		});

		it('allows supported agent reports', () => {
			expect(getUnsupportedAgentReportError(['opencode', 'weekly'])).toBeUndefined();
		});
	});
}
