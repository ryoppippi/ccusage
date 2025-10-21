import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dashboardCommand } from './commands/dashboard.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { dailyCommand } from './commands/daily.ts';

const subCommands = new Map([
	['dashboard', dashboardCommand],
	['monthly', monthlyCommand],
	['daily', dailyCommand],
]);

const mainCommand = dashboardCommand;

export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'aiusage') {
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
