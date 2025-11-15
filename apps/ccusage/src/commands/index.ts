import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../../package.json';
import { blocksCommand } from './blocks.ts';
import { dailyCommand } from './daily.ts';
import { hourlyCommand } from './hourly.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { statuslineCommand } from './statusline.ts';
import { weeklyCommand } from './weekly.ts';

// Re-export all commands for easy importing
export { blocksCommand, dailyCommand, hourlyCommand, monthlyCommand, sessionCommand, statuslineCommand, weeklyCommand };

/**
 * Command entries as tuple array
 */
export const subCommandUnion = [
	['daily', dailyCommand],
	['hourly', hourlyCommand],
	['monthly', monthlyCommand],
	['weekly', weeklyCommand],
	['session', sessionCommand],
	['blocks', blocksCommand],
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
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage') {
		args = args.slice(1);
	}

	await cli(args, mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}
