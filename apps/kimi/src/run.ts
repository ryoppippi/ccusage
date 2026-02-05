import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { sessionCommand } from './commands/session.ts';
import { weeklyCommand } from './commands/weekly.ts';

const subCommands = new Map([
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['session', sessionCommand],
	['weekly', weeklyCommand],
]);

const mainCommand = dailyCommand;

export async function run(): Promise<void> {
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage-kimi') {
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
