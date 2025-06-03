#!/usr/bin/env node

import process from "node:process";
import { cli } from "gunshi";
import { description, name, version } from "../package.json";
import { dailyCommand } from "./commands/daily.ts";
import { sessionCommand } from "./commands/session.ts";

// Create subcommands map
const subCommands = new Map();
subCommands.set("daily", dailyCommand);
subCommands.set("session", sessionCommand);

const mainCommand = dailyCommand;

await cli(process.argv.slice(2), mainCommand, {
	name,
	version,
	description,
	subCommands,
	renderHeader: null,
});
