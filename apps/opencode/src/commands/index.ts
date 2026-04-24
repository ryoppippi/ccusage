import { dateFilterArgs } from '../_shared-args.ts';
import { dailyCommand } from './daily.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { weeklyCommand } from './weekly.ts';

export { dailyCommand, monthlyCommand, sessionCommand, weeklyCommand };

if (import.meta.vitest != null) {
	const { describe, expect, it } = import.meta.vitest;

	type DateArg = {
		readonly short: string;
		readonly description: string;
		readonly parse: (value: string) => string;
	};
	type CommandWithDateArgs = {
		args: {
			since?: DateArg;
			until?: DateArg;
		};
	};

	describe('OpenCode command date filter arguments', () => {
		it.each([
			['daily', dailyCommand],
			['weekly', weeklyCommand],
			['monthly', monthlyCommand],
			['session', sessionCommand],
		])('should expose shared since and until args for %s', (_name, command) => {
			const args = (command as CommandWithDateArgs).args;

			expect(args.since).toBe(dateFilterArgs.since);
			expect(args.until).toBe(dateFilterArgs.until);
		});
	});
}
