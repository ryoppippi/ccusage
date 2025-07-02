// Shared CSV output utilities for ccusage commands
import { arrayToCsv, formatDecimal } from './_csv-utils.ts';
import { calculateTotals, getTotalTokens } from './calculate-cost.ts';
import { log } from './logger.ts';

/**
 * Common data structure for CSV output
 */
type CsvRowData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

/**
 * Configuration for CSV output
 */
type CsvOutputConfig = {
	/** Headers for the CSV file */
	headers: string[];
	/** Empty headers template when no data */
	emptyHeaders: string;
	/** Function to extract row data from each item */
	rowMapper: (item: any) => Record<string, unknown>;
	/** Whether to include totals row */
	includeTotals?: boolean;
};

/**
 * Validates that values can be used together
 */
function validateCsvJsonExclusive(hasJson: boolean, hasCsv: boolean): void {
	if (hasJson && hasCsv) {
		throw new Error('Cannot use both --json and --csv options together');
	}
}

/**
 * Outputs data in CSV format with optional totals
 */
function outputCsvData<T extends CsvRowData>(
	data: T[],
	config: CsvOutputConfig,
): void {
	if (data.length === 0) {
		log(config.emptyHeaders);
		return;
	}

	// Convert data to CSV format
	const csvData = data.map(config.rowMapper);
	log(arrayToCsv(csvData, config.headers));

	// Add totals row if requested
	if (config.includeTotals && data.length > 0) {
		const totals = calculateTotals(data);
		log(''); // Empty line before totals

		// Create totals row with appropriate number of empty columns
		const totalValues = [
			totals.inputTokens,
			totals.outputTokens,
			totals.cacheCreationTokens,
			totals.cacheReadTokens,
			getTotalTokens(totals),
			formatDecimal(totals.totalCost),
		];

		// Calculate number of columns before token data
		const columnsBeforeTokens = config.headers.length - totalValues.length;
		const emptyColumns = new Array(columnsBeforeTokens).fill('').join(',');
		const totalRow = emptyColumns ? `Total,${emptyColumns.slice(1)},${totalValues.join(',')}` : `Total,${totalValues.join(',')}`;

		log(totalRow);
	}
}

/**
 * Daily/Monthly CSV output handler
 */
export function handleUsageDataCsv<T extends CsvRowData & { date?: string; month?: string }>(
	data: T[],
	hasJson: boolean,
	hasCsv: boolean,
	type: 'daily' | 'monthly',
): void {
	validateCsvJsonExclusive(hasJson, hasCsv);

	if (!hasCsv) { return; }

	const timeField = type === 'daily' ? 'Date' : 'Month';
	const timeKey = type === 'daily' ? 'date' : 'month';

	outputCsvData(data as any, {
		headers: [timeField, 'Models', 'InputTokens', 'OutputTokens', 'CacheCreationTokens', 'CacheReadTokens', 'TotalTokens', 'Cost'],
		emptyHeaders: `${timeField},Models,InputTokens,OutputTokens,CacheCreationTokens,CacheReadTokens,TotalTokens,Cost`,
		includeTotals: true,
		rowMapper: item => ({
			[timeField]: item[timeKey],
			Models: item.modelsUsed.join(';'),
			InputTokens: item.inputTokens,
			OutputTokens: item.outputTokens,
			CacheCreationTokens: item.cacheCreationTokens,
			CacheReadTokens: item.cacheReadTokens,
			TotalTokens: getTotalTokens(item),
			Cost: formatDecimal(item.totalCost),
		}),
	});
}

/**
 * Session CSV output handler
 */
export function handleSessionCsv<T extends CsvRowData & { sessionId: string; lastActivity: string }>(
	data: T[],
	hasJson: boolean,
	hasCsv: boolean,
): void {
	validateCsvJsonExclusive(hasJson, hasCsv);

	if (!hasCsv) { return; }

	outputCsvData(data as any, {
		headers: ['SessionID', 'Models', 'InputTokens', 'OutputTokens', 'CacheCreationTokens', 'CacheReadTokens', 'TotalTokens', 'Cost', 'LastActivity'],
		emptyHeaders: 'SessionID,Models,InputTokens,OutputTokens,CacheCreationTokens,CacheReadTokens,TotalTokens,Cost,LastActivity',
		includeTotals: true,
		rowMapper: item => ({
			SessionID: item.sessionId.split('-').slice(-2).join('-'), // Display last two parts
			Models: item.modelsUsed.join(';'),
			InputTokens: item.inputTokens,
			OutputTokens: item.outputTokens,
			CacheCreationTokens: item.cacheCreationTokens,
			CacheReadTokens: item.cacheReadTokens,
			TotalTokens: getTotalTokens(item),
			Cost: formatDecimal(item.totalCost),
			LastActivity: item.lastActivity,
		}),
	});
}

/**
 * Blocks CSV output handler
 */
export function handleBlocksCsv<T extends {
	startTime: Date;
	endTime: Date;
	actualEndTime?: Date;
	isActive: boolean;
	isGap?: boolean;
	models: string[];
	tokenCounts: { inputTokens: number; outputTokens: number };
	costUSD: number;
}>(
	data: T[],
	hasJson: boolean,
	hasCsv: boolean,
	tokenLimit?: string,
	maxTokensFromAll?: number,
): void {
	validateCsvJsonExclusive(hasJson, hasCsv);

	if (!hasCsv) { return; }

	outputCsvData(data as any, {
		headers: ['BlockStart', 'Duration', 'Models', 'Tokens', 'Percentage', 'Cost'],
		emptyHeaders: 'BlockStart,Duration,Models,Tokens,Percentage,Cost',
		includeTotals: false, // Blocks don't have traditional totals
		rowMapper: (block) => {
			if (block.isGap) {
				const duration = Math.round((block.endTime.getTime() - block.startTime.getTime()) / (1000 * 60 * 60));
				return {
					BlockStart: block.startTime.toISOString(),
					Duration: `${duration}h gap`,
					Models: '-',
					Tokens: 0,
					Percentage: '',
					Cost: 0,
				};
			}

			const totalTokens = block.tokenCounts.inputTokens + block.tokenCounts.outputTokens;
			let duration: string;

			if (block.isActive) {
				duration = 'ACTIVE';
			}
			else if (block.actualEndTime) {
				const durationMins = Math.round((block.actualEndTime.getTime() - block.startTime.getTime()) / (1000 * 60));
				const hours = Math.floor(durationMins / 60);
				const mins = durationMins % 60;
				duration = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
			}
			else {
				duration = '-';
			}

			// Calculate percentage if token limit is set
			const parseTokenLimit = (value?: string, max?: number): number | undefined => {
				if (!value) { return undefined; }
				if (value === 'max') { return max && max > 0 ? max : undefined; }
				const limit = Number.parseInt(value, 10);
				return Number.isNaN(limit) ? undefined : limit;
			};

			const actualTokenLimit = parseTokenLimit(tokenLimit, maxTokensFromAll);
			const percentage = actualTokenLimit && actualTokenLimit > 0
				? ((totalTokens / actualTokenLimit) * 100).toFixed(1)
				: '';

			return {
				BlockStart: block.startTime.toISOString(),
				Duration: duration,
				Models: block.models.join(';'),
				Tokens: totalTokens,
				Percentage: percentage,
				Cost: formatDecimal(block.costUSD),
			};
		},
	});
}

if (import.meta.vitest != null) {
	const { describe, it, expect, vi } = import.meta.vitest;

	// Mock logger
	vi.mock('./logger.ts', () => ({
		log: vi.fn(),
	}));

	describe('CSV output handlers', () => {
		it('should validate json/csv exclusivity', () => {
			expect(() => validateCsvJsonExclusive(true, true)).toThrow('Cannot use both --json and --csv options together');
			expect(() => validateCsvJsonExclusive(true, false)).not.toThrow();
			expect(() => validateCsvJsonExclusive(false, true)).not.toThrow();
		});

		it('should handle daily CSV output', async () => {
			const data = [{
				date: '2024-01-15',
				modelsUsed: ['claude-sonnet-4'],
				inputTokens: 100,
				outputTokens: 50,
				cacheCreationTokens: 10,
				cacheReadTokens: 5,
				totalCost: 0.01,
			}];

			handleUsageDataCsv(data, false, true, 'daily');

			const { log } = vi.mocked(await import('./logger.ts'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('Date,Models,InputTokens'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('2024-01-15,claude-sonnet-4,100,50'));
		});

		it('should handle session CSV output', async () => {
			const data = [{
				sessionId: 'project-session-12345',
				modelsUsed: ['claude-opus-4'],
				inputTokens: 200,
				outputTokens: 100,
				cacheCreationTokens: 20,
				cacheReadTokens: 10,
				totalCost: 0.02,
				lastActivity: '2024-01-15T10:00:00Z',
			}];

			handleSessionCsv(data, false, true);

			const { log } = vi.mocked(await import('./logger.ts'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('SessionID,Models,InputTokens'));
			expect(log).toHaveBeenCalledWith(expect.stringContaining('session-12345,claude-opus-4,200,100'));
		});
	});
}
