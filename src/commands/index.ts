import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../../package.json';
import { blocksCommand } from './blocks.ts';
import { dailyCommand } from './daily.ts';
import { mcpCommand } from './mcp.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { statuslineCommand } from './statusline.ts';
import { weeklyCommand } from './weekly.ts';

// Re-export all commands for easy importing
export { blocksCommand, dailyCommand, mcpCommand, monthlyCommand, sessionCommand, statuslineCommand, weeklyCommand };

/**
 * Command entries as tuple array
 */
export const subCommandUnion = [
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['weekly', weeklyCommand],
	['session', sessionCommand],
	['blocks', blocksCommand],
	['mcp', mcpCommand],
	['statusline', statuslineCommand],
] as const;

/**
 * Available command names extracted from union
 */
export type CommandName = typeof subCommandUnion[number][0];

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
const mainCommand = dailyCommand;

export async function run(): Promise<void> {
	await cli(process.argv.slice(2), mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}
