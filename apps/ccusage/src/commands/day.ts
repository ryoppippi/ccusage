import type { ActivityEntry as ChartActivityEntry } from '@ccusage/terminal/charts';
import process from 'node:process';
import { createDayActivityGrid } from '@ccusage/terminal/charts';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import * as v from 'valibot';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedArgs } from '../_shared-args.ts';
import { loadDayActivityData } from '../data-loader.ts';
import { log, logger } from '../logger.ts';

/**
 * Valibot schema for date in YYYYMMDD format (like --since/--until)
 */
const dateArgSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/, 'Date must be in YYYYMMDD format'),
	v.transform((val) => {
		// convert YYYYMMDD to YYYY-MM-DD
		return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
	}),
);

/**
 * Parse date argument from YYYYMMDD to YYYY-MM-DD format
 */
function parseDateArg(value: string): string {
	return v.parse(dateArgSchema, value);
}

/**
 * Shorten model name by removing the trailing date suffix.
 * e.g., "claude-opus-4-5-20251101" -> "claude-opus-4-5"
 */
function shortenModelName(model: string): string {
	// match pattern like -YYYYMMDD at the end
	return model.replace(/-\d{8}$/, '');
}

export const dayCommand = define({
	name: 'day',
	description: 'Show activity heatmap for a single day (15-minute windows)',
	args: {
		...sharedArgs,
		date: {
			type: 'custom',
			short: 'D',
			description: 'Date to display (YYYYMMDD format, defaults to today)',
			parse: parseDateArg,
		},
		metric: {
			type: 'enum',
			short: 'M',
			description: 'Metric to visualize: cost or output tokens',
			default: 'cost' as const,
			choices: ['cost', 'output'] as const,
		},
	},
	toKebab: true,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Get date (defaults to today in local time)
		const now = new Date();
		const localYear = now.getFullYear();
		const localMonth = String(now.getMonth() + 1).padStart(2, '0');
		const localDay = String(now.getDate()).padStart(2, '0');
		const targetDate = ctx.values.date ?? `${localYear}-${localMonth}-${localDay}`;

		// Load entries for the day
		const entries = await loadDayActivityData(targetDate, {
			mode: mergedOptions.mode,
			offline: mergedOptions.offline,
			refreshPricing: mergedOptions.refreshPricing,
			timezone: mergedOptions.timezone,
		});

		if (useJson) {
			// JSON output
			const jsonOutput = {
				date: targetDate,
				metric: ctx.values.metric,
				entries: entries.map((e) => ({
					timestamp: e.timestamp,
					cost: e.cost,
					outputTokens: e.outputTokens,
					model: e.model,
				})),
				summary: {
					totalCost: entries.reduce((sum, e) => sum + e.cost, 0),
					totalOutputTokens: entries.reduce((sum, e) => sum + e.outputTokens, 0),
					entryCount: entries.length,
				},
			};

			// Process with jq if specified
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
			} else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		} else {
			// Print header
			logger.box('Claude Code Activity Heatmap');

			// Convert to chart format
			const chartEntries: ChartActivityEntry[] = entries.map((e) => ({
				timestamp: e.timestamp,
				cost: e.cost,
				outputTokens: e.outputTokens,
			}));

			// Render the activity grid
			const grid = createDayActivityGrid(chartEntries, {
				date: targetDate,
				timezone: mergedOptions.timezone,
				metric: ctx.values.metric,
			});

			log(grid);

			// Show models used (filter synthetic, shorten names)
			const models = [
				...new Set(
					entries
						.map((e) => e.model)
						.filter((m): m is string => m != null && !m.includes('synthetic'))
						.map(shortenModelName),
				),
			];
			if (models.length > 0) {
				log('');
				log(`Models: ${models.join(', ')}`);
			}
		}
	},
});
