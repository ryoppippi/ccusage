#!/usr/bin/env node

import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { sessionCommand } from './commands/session.ts';

const subCommands = new Map([
	['daily', dailyCommand],
	['monthly', monthlyCommand],
	['session', sessionCommand],
]);

const mainCommand = dailyCommand;

async function run(): Promise<void> {
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage-pi') {
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

// eslint-disable-next-line antfu/no-top-level-await
await run();
