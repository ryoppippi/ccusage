import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../../package.json';
import { i18n } from '../_i18n.ts';
import { blocksCommand } from './blocks.ts';
import { dailyCommand } from './daily.ts';
import { mcpCommand } from './mcp.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';

/**
 * Early initialization of i18n to support command descriptions
 * Parse command line arguments to detect --lang early
 */
function initializeI18nEarly(): void {
	const argv = process.argv.slice(2);

	// Look for --lang or -l argument
	let lang = 'auto';
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined || arg === null || arg === '') {
			continue;
		}

		if (arg === '--lang' || arg === '-l') {
			const nextArg = argv[i + 1];
			if (i + 1 < argv.length && nextArg !== undefined && nextArg !== null && nextArg !== '') {
				lang = nextArg;
			}
		}
		// Handle --lang=value format
		if (arg.startsWith('--lang=')) {
			const parts = arg.split('=');
			if (parts.length > 1 && parts[1] !== undefined && parts[1] !== null && parts[1] !== '') {
				lang = parts[1];
			}
		}
	}

	// Initialize i18n early
	i18n.initialize(lang);
}

// Initialize i18n before defining commands
initializeI18nEarly();

/**
 * Map of available CLI subcommands
 */
const subCommands = new Map();
subCommands.set('daily', dailyCommand);
subCommands.set('monthly', monthlyCommand);
subCommands.set('session', sessionCommand);
subCommands.set('blocks', blocksCommand);
subCommands.set('mcp', mcpCommand);

/**
 * Default command when no subcommand is specified (defaults to daily)
 */
const mainCommand = dailyCommand;

// eslint-disable-next-line antfu/no-top-level-await
await cli(process.argv.slice(2), mainCommand, {
	name,
	version,
	description,
	subCommands,
	renderHeader: null,
});
