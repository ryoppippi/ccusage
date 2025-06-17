import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../../package.json';
import { blocksCommand } from './blocks.ts';
import { dailyCommand } from './daily.ts';
import { mcpCommand } from './mcp.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';

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
