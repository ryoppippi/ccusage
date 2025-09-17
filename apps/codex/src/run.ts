import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';

const subCommands = new Map([
	['daily', dailyCommand],
]);

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
