import { dailyCommand } from './daily.ts';
import { monthlyCommand } from './monthly.ts';
import { sessionCommand } from './session.ts';
import { weeklyCommand } from './weekly.ts';

export { dailyCommand } from './daily.ts';
export { monthlyCommand } from './monthly.ts';
export { sessionCommand } from './session.ts';
export { weeklyCommand } from './weekly.ts';

if (import.meta.vitest != null) {
	const { describe, expect, it } = import.meta.vitest;

	type DateArg = {
		short: string;
		description: string;
		parse: (value: string) => string;
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
		])('should expose main-mode compatible since and until args for %s', (_name, command) => {
			const args = (command as CommandWithDateArgs).args;

			expect(args.since?.short).toBe('s');
			expect(args.since?.description).toBe('Filter from date (YYYYMMDD format)');
			expect(args.since?.parse('20240102')).toBe('20240102');
			expect(() => args.since?.parse('2024-01-02')).toThrow('Date must be in YYYYMMDD format');

			expect(args.until?.short).toBe('u');
			expect(args.until?.description).toBe('Filter until date (YYYYMMDD format)');
			expect(args.until?.parse('20240103')).toBe('20240103');
			expect(() => args.until?.parse('2024-01-03')).toThrow('Date must be in YYYYMMDD format');
		});
	});
}
