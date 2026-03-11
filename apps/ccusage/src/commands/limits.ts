import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import process from 'node:process';
import { ResponsiveTable } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import { filterByDateRange, sortByDate } from '../_date-utils.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedArgs } from '../_shared-args.ts';
import { log, logger } from '../logger.ts';

/**
 * Schema for validating the date filter argument
 */
const filterDateSchema = v.pipe(
	v.string(),
	v.regex(/^\d{8}$/u, 'Date must be in YYYYMMDD format'),
);

/**
 * Parses and validates a date argument in YYYYMMDD format
 * @param value - Date string to parse
 * @returns Validated date string
 */
function parseDateArg(value: string): string {
	return v.parse(filterDateSchema, value);
}

/**
 * Rate limit event extracted from JSONL logs
 */
type RateLimitEvent = {
	/** ISO timestamp of when the limit was hit */
	timestamp: string;
	/** The reset message from Claude Code */
	resetMessage: string;
	/** Inferred limit type: 'Weekly' or '5-hour' */
	limitType: 'Weekly' | '5-hour';
	/** Project path (relative) */
	project: string;
	/** Session ID */
	sessionId: string;
};

/**
 * Infers the limit type from the reset message and timestamp
 * Weekly limits:
 * - Contain a date like "Jan 24", "Feb 5", etc.
 * - Contain day references like "Mon at", "tomorrow at"
 * - Reset at 6pm on Saturday (when you hit the weekly limit on Saturday)
 * 5-hour limits are simpler time-based resets within the same day
 */
function inferLimitType(resetMessage: string, timestamp?: string): 'Weekly' | '5-hour' {
	// Weekly patterns:
	// - Contains a date like "Jan 24", "Feb 5", etc.
	// - Contains day references like "Mon at", "tomorrow at"
	const datePattern = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/i;
	const dayPattern = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|tomorrow)\s+at\b/i;

	if (datePattern.test(resetMessage) || dayPattern.test(resetMessage)) {
		return 'Weekly';
	}

	// Check if reset is at 6pm on Saturday - this is the weekly limit reset
	// The weekly limit resets at 6pm on Saturdays (Hong Kong time)
	if (timestamp != null && resetMessage.includes('6pm')) {
		const date = new Date(timestamp);
		// Check if it's Saturday (day 6)
		// We need to convert to HKT to properly check the day
		const hktFormatter = new Intl.DateTimeFormat('en-US', {
			timeZone: 'Asia/Hong_Kong',
			weekday: 'short',
		});
		const dayInHKT = hktFormatter.format(date);
		if (dayInHKT === 'Sat') {
			return 'Weekly';
		}
	}

	// Default to 5-hour for simple time patterns
	return '5-hour';
}

/**
 * Parses a single JSONL line and extracts rate limit event if present
 */
function parseRateLimitEntry(
	line: string,
	filePath: string,
): RateLimitEvent | null {
	try {
		const entry = JSON.parse(line) as Record<string, unknown>;

		// Check for rate_limit error
		if (entry.error !== 'rate_limit') {
			return null;
		}

		// Extract timestamp
		const timestamp = entry.timestamp;
		if (typeof timestamp !== 'string') {
			return null;
		}

		// Extract the reset message from content
		const message = entry.message as Record<string, unknown> | undefined;
		const content = message?.content as Array<{ type: string; text?: string }> | undefined;

		let resetMessage = '';
		if (Array.isArray(content)) {
			for (const item of content) {
				if (item.type === 'text' && typeof item.text === 'string') {
					resetMessage = item.text;
					break;
				}
			}
		}

		// Extract session ID
		const sessionId = entry.sessionId;
		if (typeof sessionId !== 'string') {
			return null;
		}

		// Extract project path from file path
		const projectsDir = join(homedir(), '.claude', 'projects');
		const projectPath = relative(projectsDir, filePath);
		const project = projectPath.split('/')[0] ?? 'unknown';

		return {
			timestamp,
			resetMessage,
			limitType: inferLimitType(resetMessage, timestamp),
			project,
			sessionId,
		};
	} catch {
		return null;
	}
}

/**
 * Scans all JSONL files for rate limit events
 */
async function scanForRateLimits(): Promise<RateLimitEvent[]> {
	const projectsDir = join(homedir(), '.claude', 'projects');
	const pattern = join(projectsDir, '*', '*.jsonl');

	const files = await glob(pattern, { onlyFiles: true });
	const events: RateLimitEvent[] = [];

	for (const filePath of files) {
		const { createReadStream } = await import('node:fs');
		const { createInterface } = await import('node:readline');

		const fileStream = createReadStream(filePath);
		const rl = createInterface({
			input: fileStream,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		for await (const line of rl) {
			if (line.includes('"error":"rate_limit"')) {
				const event = parseRateLimitEntry(line, filePath);
				if (event != null) {
					events.push(event);
				}
			}
		}
	}

	return events;
}

/**
 * Formats a timestamp to local date/time string
 */
function formatLocalDateTime(
	timestamp: string,
	timezone?: string,
	locale?: string,
): string {
	const date = new Date(timestamp);
	const formatter = new Intl.DateTimeFormat(locale ?? 'en-US', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
		timeZone: timezone,
	});
	return formatter.format(date);
}

/**
 * Extracts the reset time portion from the full reset message
 */
function extractResetTime(resetMessage: string): string {
	// Remove "You've hit your limit · resets " prefix if present
	const match = resetMessage.match(/resets?\s+(.+)$/i);
	if (match?.[1] != null) {
		return match[1];
	}
	return resetMessage;
}

export const limitsCommand = define({
	name: 'limits',
	description: 'Show historical rate limit events from Claude Code logs',
	toKebab: true,
	args: {
		limit: {
			type: 'number',
			short: 'n',
			description: 'Maximum number of events to show (default: 10)',
			default: 10,
		},
		since: {
			type: 'custom',
			short: 's',
			description: 'Filter from date (YYYYMMDD format)',
			parse: parseDateArg,
		},
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
			default: false,
		},
		jq: sharedArgs.jq,
		timezone: sharedArgs.timezone,
		locale: sharedArgs.locale,
	},
	async run(ctx) {
		// --jq implies --json
		const useJson = Boolean(ctx.values.json) || ctx.values.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Scan for rate limit events
		const allEvents = await scanForRateLimits();

		if (allEvents.length === 0) {
			if (useJson) {
				log(JSON.stringify({ events: [], total: 0 }));
			} else {
				logger.info('No rate limit events found.');
			}
			process.exit(0);
		}

		// Filter by date if specified
		let filteredEvents = ctx.values.since != null
			? filterByDateRange(allEvents, (e) => e.timestamp, ctx.values.since)
			: allEvents;

		// Sort by timestamp (newest first)
		filteredEvents = sortByDate(filteredEvents, (e) => e.timestamp, 'desc');

		// Apply limit
		const limitedEvents = filteredEvents.slice(0, ctx.values.limit);

		if (useJson) {
			const jsonOutput = {
				events: limitedEvents.map((e) => ({
					hitTime: e.timestamp,
					resetTime: extractResetTime(e.resetMessage),
					type: e.limitType,
					project: e.project,
					sessionId: e.sessionId,
				})),
				total: filteredEvents.length,
				showing: limitedEvents.length,
			};

			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
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
			logger.box('Claude Code Rate Limit History');

			// Build table using ResponsiveTable
			const table = new ResponsiveTable({
				head: ['Hit Time', 'Reset Time', 'Type'],
				style: { head: ['cyan'] },
				colAligns: ['left', 'left', 'left'],
			});

			for (const event of limitedEvents) {
				const hitTime = formatLocalDateTime(
					event.timestamp,
					ctx.values.timezone,
					ctx.values.locale,
				);
				const resetTime = extractResetTime(event.resetMessage);
				const typeColor = event.limitType === 'Weekly' ? pc.yellow : pc.green;

				table.push([hitTime, resetTime, typeColor(event.limitType)]);
			}

			log(table.toString());

			// Show summary
			if (filteredEvents.length > limitedEvents.length) {
				logger.info(
					`\nShowing ${limitedEvents.length} of ${filteredEvents.length} events. Use --limit to see more.`,
				);
			} else {
				logger.info(`\nTotal: ${filteredEvents.length} rate limit events.`);
			}
		}
	},
});
