import process from 'node:process';
import Table from 'cli-table3';
import { uniq } from 'es-toolkit';
import pc from 'picocolors';
import stringWidth from 'string-width';

/**
 * Horizontal alignment options for table cells
 */
export type TableCellAlign = 'left' | 'right' | 'center';

/**
 * Table row data type supporting strings, numbers, and formatted cell objects
 */
export type TableRow = (string | number | { content: string; hAlign?: TableCellAlign })[];

/**
 * Configuration options for creating responsive tables
 */
export type TableOptions = {
	head: string[];
	colAligns?: TableCellAlign[];
	style?: {
		head?: string[];
	};
	dateFormatter?: (dateStr: string) => string;
	compactHead?: string[];
	compactColAligns?: TableCellAlign[];
	compactThreshold?: number;
	forceCompact?: boolean;
	logger?: (message: string) => void;
};

/**
 * Responsive table class that adapts column widths based on terminal size
 * Automatically adjusts formatting and layout for different screen sizes
 */
export class ResponsiveTable {
	private head: string[];
	private rows: TableRow[] = [];
	private colAligns: TableCellAlign[];
	private style?: { head?: string[] };
	private dateFormatter?: (dateStr: string) => string;
	private compactHead?: string[];
	private compactColAligns?: TableCellAlign[];
	private compactThreshold: number;
	private compactMode = false;
	private forceCompact: boolean;
	private logger: (message: string) => void;

	/**
	 * Creates a new responsive table instance
	 * @param options - Table configuration options
	 */
	constructor(options: TableOptions) {
		this.head = options.head;
		this.colAligns = options.colAligns ?? Array.from({ length: this.head.length }, () => 'left');
		this.style = options.style;
		this.dateFormatter = options.dateFormatter;
		this.compactHead = options.compactHead;
		this.compactColAligns = options.compactColAligns;
		this.compactThreshold = options.compactThreshold ?? 100;
		this.forceCompact = options.forceCompact ?? false;
		this.logger = options.logger ?? (() => {});
	}

	/**
	 * Adds a row to the table
	 * @param row - Row data to add
	 */
	push(row: TableRow): void {
		this.rows.push(row);
	}

	/**
	 * Filters a row to compact mode columns
	 * @param row - Row to filter
	 * @param compactIndices - Indices of columns to keep in compact mode
	 * @returns Filtered row
	 */
	private filterRowToCompact(row: TableRow, compactIndices: number[]): TableRow {
		return compactIndices.map(index => row[index] ?? '');
	}

	/**
\t * Gets the current table head and col aligns based on compact mode
	 * @returns Current head and colAligns arrays
	 */
	private getCurrentTableConfig(): { head: string[]; colAligns: TableCellAlign[] } {
		if (this.compactMode && this.compactHead != null && this.compactColAligns != null) {
			return { head: this.compactHead, colAligns: this.compactColAligns };
		}
		return { head: this.head, colAligns: this.colAligns };
	}

	/**
	 * Gets indices mapping from full table to compact table
	 * @returns Array of column indices to keep in compact mode
	 */
	private getCompactIndices(): number[] {
		if (this.compactHead == null || !this.compactMode) {
			return Array.from({ length: this.head.length }, (_, i) => i);
		}

		// Map compact headers to original indices
		return this.compactHead.map((compactHeader) => {
			const index = this.head.indexOf(compactHeader);
			if (index < 0) {
				// Log warning for debugging configuration issues
				this.logger(`Warning: Compact header "${compactHeader}" not found in table headers [${this.head.join(', ')}]. Using first column as fallback.`);
				return 0; // fallback to first column if not found
			}
			return index;
		});
	}

	/**
	 * Returns whether the table is currently in compact mode
	 * @returns True if compact mode is active
	 */
	isCompactMode(): boolean {
		return this.compactMode;
	}

	/**
	 * Renders the table as a formatted string
	 * Automatically adjusts layout based on terminal width
	 * @returns Formatted table string
	 */
	toString(): string {
		// Check environment variable first, then process.stdout.columns, then default
		const terminalWidth = Number.parseInt(process.env.COLUMNS ?? '', 10) || process.stdout.columns || 120;

		// Determine if we should use compact mode
		this.compactMode = this.forceCompact || (terminalWidth < this.compactThreshold && this.compactHead != null);

		// Get current table configuration
		const { head, colAligns } = this.getCurrentTableConfig();
		const compactIndices = this.getCompactIndices();

		// Calculate actual content widths first (excluding separator rows)
		const dataRows = this.rows.filter(row => !this.isSeparatorRow(row));

		// Filter rows to compact mode if needed
		const processedDataRows = this.compactMode
			? dataRows.map(row => this.filterRowToCompact(row, compactIndices))
			: dataRows;

		const allRows = [head.map(String), ...processedDataRows.map(row => row.map((cell) => {
			if (typeof cell === 'object' && cell != null && 'content' in cell) {
				return String(cell.content);
			}
			return String(cell ?? '');
		}))];

		const contentWidths = head.map((_, colIndex) => {
			const maxLength = Math.max(
				...allRows.map(row => stringWidth(String(row[colIndex] ?? ''))),
			);
			return maxLength;
		});

		// Calculate table overhead
		const numColumns = head.length;
		const tableOverhead = 3 * numColumns + 1; // borders and separators
		const availableWidth = terminalWidth - tableOverhead;

		// Always use content-based widths with generous padding for numeric columns
		const columnWidths = contentWidths.map((width, index) => {
			const align = colAligns[index];
			// For numeric columns, ensure generous width to prevent truncation
			if (align === 'right') {
				return Math.max(width + 3, 11); // At least 11 chars for numbers, +3 padding
			}
			else if (index === 1) {
				// Models column - can be longer
				return Math.max(width + 2, 15);
			}
			return Math.max(width + 2, 10); // Other columns
		});

		// Check if this fits in the terminal
		const totalRequiredWidth = columnWidths.reduce((sum, width) => sum + width, 0) + tableOverhead;

		if (totalRequiredWidth > terminalWidth) {
			// Apply responsive resizing and use compact date format if available
			const scaleFactor = availableWidth / columnWidths.reduce((sum, width) => sum + width, 0);
			const adjustedWidths = columnWidths.map((width, index) => {
				const align = colAligns[index];
				let adjustedWidth = Math.floor(width * scaleFactor);

				// Apply minimum widths based on column type
				if (align === 'right') {
					adjustedWidth = Math.max(adjustedWidth, 10);
				}
				else if (index === 0) {
					adjustedWidth = Math.max(adjustedWidth, 10);
				}
				else if (index === 1) {
					adjustedWidth = Math.max(adjustedWidth, 12);
				}
				else {
					adjustedWidth = Math.max(adjustedWidth, 8);
				}

				return adjustedWidth;
			});

			const table = new Table({
				head,
				style: this.style,
				colAligns,
				colWidths: adjustedWidths,
				wordWrap: true,
				wrapOnWordBoundary: true,
			});

			// Add rows with special handling for separators and date formatting
			for (const row of this.rows) {
				if (this.isSeparatorRow(row)) {
					// Skip separator rows - cli-table3 will handle borders automatically
					continue;
				}
				else {
					// Use compact date format for first column if dateFormatter available
					let processedRow = row.map((cell, index) => {
						if (index === 0 && this.dateFormatter != null && typeof cell === 'string' && this.isDateString(cell)) {
							return this.dateFormatter(cell);
						}
						return cell;
					});

					// Filter to compact columns if in compact mode
					if (this.compactMode) {
						processedRow = this.filterRowToCompact(processedRow, compactIndices);
					}

					table.push(processedRow);
				}
			}

			return table.toString();
		}
		else {
			// Use generous column widths with normal date format
			const table = new Table({
				head,
				style: this.style,
				colAligns,
				colWidths: columnWidths,
				wordWrap: true,
				wrapOnWordBoundary: true,
			});

			// Add rows with special handling for separators
			for (const row of this.rows) {
				if (this.isSeparatorRow(row)) {
					// Skip separator rows - cli-table3 will handle borders automatically
					continue;
				}
				else {
					// Filter to compact columns if in compact mode
					const processedRow = this.compactMode
						? this.filterRowToCompact(row, compactIndices)
						: row;
					table.push(processedRow);
				}
			}

			return table.toString();
		}
	}

	/**
	 * Checks if a row is a separator row (contains only empty cells or dashes)
	 * @param row - Row to check
	 * @returns True if the row is a separator
	 */
	private isSeparatorRow(row: TableRow): boolean {
		// Check for both old-style separator rows (─) and new-style empty rows
		return row.every((cell) => {
			if (typeof cell === 'object' && cell != null && 'content' in cell) {
				return cell.content === '' || /^─+$/.test(cell.content);
			}
			return typeof cell === 'string' && (cell === '' || /^─+$/.test(cell));
		});
	}

	/**
	 * Checks if a string matches the YYYY-MM-DD date format
	 * @param text - String to check
	 * @returns True if the string is a valid date format
	 */
	private isDateString(text: string): boolean {
		// Check if string matches date format YYYY-MM-DD
		return /^\d{4}-\d{2}-\d{2}$/.test(text);
	}
}

/**
 * Formats a number with locale-specific thousand separators
 * @param num - The number to format
 * @returns Formatted number string with commas as thousand separators
 */
export function formatNumber(num: number): string {
	return num.toLocaleString('en-US');
}

/**
 * Formats a number as USD currency with dollar sign and 2 decimal places
 * @param amount - The amount to format
 * @returns Formatted currency string (e.g., "$12.34")
 */
export function formatCurrency(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/**
 * Formats Claude model names into a shorter, more readable format
 * Extracts model type and generation from full model name
 * @param modelName - Full model name (e.g., "claude-sonnet-4-20250514")
 * @returns Shortened model name (e.g., "sonnet-4") or original if pattern doesn't match
 */
function formatModelName(modelName: string): string {
	// Extract model type from full model name
	// e.g., "claude-sonnet-4-20250514" -> "sonnet-4"
	// e.g., "claude-opus-4-20250514" -> "opus-4"
	const match = modelName.match(/claude-(\w+)-(\d+)-\d+/);
	if (match != null) {
		return `${match[1]}-${match[2]}`;
	}
	// Return original if pattern doesn't match
	return modelName;
}

/**
 * Formats an array of model names for display as a comma-separated string
 * Removes duplicates and sorts alphabetically
 * @param models - Array of model names
 * @returns Formatted string with unique, sorted model names separated by commas
 */
export function formatModelsDisplay(models: string[]): string {
	// Format array of models for display
	const uniqueModels = uniq(models.map(formatModelName));
	return uniqueModels.sort().join(', ');
}

/**
 * Formats an array of model names for display with each model on a new line
 * Removes duplicates and sorts alphabetically
 * @param models - Array of model names
 * @returns Formatted string with unique, sorted model names as a bulleted list
 */
export function formatModelsDisplayMultiline(models: string[]): string {
	// Format array of models for display with newlines and bullet points
	const uniqueModels = uniq(models.map(formatModelName));
	return uniqueModels.sort().map(model => `- ${model}`).join('\n');
}

/**
 * Pushes model breakdown rows to a table
 * @param table - The table to push rows to
 * @param breakdowns - Array of model breakdowns
 * @param extraColumns - Number of extra empty columns before the data (default: 1 for models column)
 * @param trailingColumns - Number of extra empty columns after the data (default: 0)
 */
export function pushBreakdownRows(
	table: { push: (row: (string | number)[]) => void },
	breakdowns: Array<{
		modelName: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		cost: number;
	}>,
	extraColumns = 1,
	trailingColumns = 0,
): void {
	for (const breakdown of breakdowns) {
		const row: (string | number)[] = [`  └─ ${formatModelName(breakdown.modelName)}`];

		// Add extra empty columns before data
		for (let i = 0; i < extraColumns; i++) {
			row.push('');
		}

		// Add data columns with gray styling
		const totalTokens = breakdown.inputTokens + breakdown.outputTokens
			+ breakdown.cacheCreationTokens + breakdown.cacheReadTokens;

		row.push(
			pc.gray(formatNumber(breakdown.inputTokens)),
			pc.gray(formatNumber(breakdown.outputTokens)),
			pc.gray(formatNumber(breakdown.cacheCreationTokens)),
			pc.gray(formatNumber(breakdown.cacheReadTokens)),
			pc.gray(formatNumber(totalTokens)),
			pc.gray(formatCurrency(breakdown.cost)),
		);

		// Add trailing empty columns
		for (let i = 0; i < trailingColumns; i++) {
			row.push('');
		}

		table.push(row);
	}
}

/**
 * Configuration options for creating usage report tables
 */
export type UsageReportConfig = {
	/** Name for the first column (Date, Month, Week, Session, etc.) */
	firstColumnName: string;
	/** Whether to include Last Activity column (for session reports) */
	includeLastActivity?: boolean;
	/** Date formatter function for responsive date formatting */
	dateFormatter?: (dateStr: string) => string;
	/** Force compact mode regardless of terminal width */
	forceCompact?: boolean;
};

/**
 * Standard usage data structure for table rows
 */
export type UsageData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed?: string[];
};

/**
 * Creates a standard usage report table with consistent styling and layout
 * @param config - Configuration options for the table
 * @returns Configured ResponsiveTable instance
 */
export function createUsageReportTable(config: UsageReportConfig): ResponsiveTable {
	const baseHeaders = [
		config.firstColumnName,
		'Models',
		'Input',
		'Output',
		'Cache (Create)',
		'Cache (Read)',
		'Total Tokens',
		'Cost',
	];

	const baseAligns: TableCellAlign[] = [
		'left',
		'left',
		'right',
		'right',
		'right',
		'right',
		'right',
		'right',
	];

	if (config.includeLastActivity) {
		baseHeaders.push('Last Activity');
		baseAligns.push('left');
	}

	return new ResponsiveTable({
		head: baseHeaders,
		colAligns: baseAligns,
		compactHead: config.includeLastActivity
			? [config.firstColumnName, 'Models', 'Cost', 'Last Activity']
			: [config.firstColumnName, 'Models', 'Cost'],
		compactColAligns: config.includeLastActivity
			? ['left', 'left', 'right', 'left']
			: ['left', 'left', 'right'],
		style: {
			head: ['cyan'],
		},
		dateFormatter: config.dateFormatter,
		forceCompact: config.forceCompact,
	});
}

/**
 * Formats usage data into a table row
 * @param data - Usage data to format
 * @param firstColumnValue - Value for the first column
 * @param lastActivity - Optional last activity string to append as final column
 * @returns Formatted table row
 */
export function formatUsageDataRow(
	firstColumnValue: string,
	data: UsageData,
	lastActivity?: string,
): (string | number)[] {
	const totalTokens = data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens;

	const row: (string | number)[] = [
		firstColumnValue,
		data.modelsUsed != null ? formatModelsDisplayMultiline(data.modelsUsed) : '',
		formatNumber(data.inputTokens),
		formatNumber(data.outputTokens),
		formatNumber(data.cacheCreationTokens),
		formatNumber(data.cacheReadTokens),
		formatNumber(totalTokens),
		formatCurrency(data.totalCost),
	];

	if (lastActivity !== undefined) {
		row.push(lastActivity);
	}

	return row;
}

/**
 * Creates a totals row with yellow highlighting
 * @param totals - Totals data to display
 * @param includeLastActivity - Whether to include an empty last activity column
 * @returns Formatted totals row
 */
export function formatTotalsRow(totals: UsageData, includeLastActivity = false): (string | number)[] {
	const totalTokens = totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;

	const row: (string | number)[] = [
		pc.yellow('Total'),
		'', // Empty for Models column in totals
		pc.yellow(formatNumber(totals.inputTokens)),
		pc.yellow(formatNumber(totals.outputTokens)),
		pc.yellow(formatNumber(totals.cacheCreationTokens)),
		pc.yellow(formatNumber(totals.cacheReadTokens)),
		pc.yellow(formatNumber(totalTokens)),
		pc.yellow(formatCurrency(totals.totalCost)),
	];

	if (includeLastActivity) {
		row.push(''); // Empty for Last Activity column in totals
	}

	return row;
}

/**
 * Adds an empty separator row to the table for visual separation
 * @param table - Table to add separator row to
 * @param columnCount - Number of columns in the table
 */
export function addEmptySeparatorRow(table: ResponsiveTable, columnCount: number): void {
	const emptyRow = Array.from({ length: columnCount }, () => '');
	table.push(emptyRow);
}

if (import.meta.vitest != null) {
	describe('ResponsiveTable', () => {
		describe('compact mode behavior', () => {
			it('should activate compact mode when terminal width is below threshold', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactHead: ['Date', 'Model', 'Cost'],
					compactThreshold: 100,
				});

				// Mock process.env.COLUMNS to simulate narrow terminal
				const originalColumns = process.env.COLUMNS;
				process.env.COLUMNS = '80';

				table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
				table.toString(); // This triggers compact mode calculation

				expect(table.isCompactMode()).toBe(true);

				// Restore original value
				process.env.COLUMNS = originalColumns;
			});

			it('should not activate compact mode when terminal width is above threshold', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactHead: ['Date', 'Model', 'Cost'],
					compactThreshold: 100,
				});

				// Mock process.env.COLUMNS to simulate wide terminal
				const originalColumns = process.env.COLUMNS;
				process.env.COLUMNS = '120';

				table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
				table.toString(); // This triggers compact mode calculation

				expect(table.isCompactMode()).toBe(false);

				// Restore original value
				process.env.COLUMNS = originalColumns;
			});

			it('should not activate compact mode when compactHead is not provided', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactThreshold: 100,
				});

				// Mock process.env.COLUMNS to simulate narrow terminal
				const originalColumns = process.env.COLUMNS;
				process.env.COLUMNS = '80';

				table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
				table.toString(); // This triggers compact mode calculation

				expect(table.isCompactMode()).toBe(false);

				// Restore original value
				process.env.COLUMNS = originalColumns;
			});
		});

		describe('getCurrentTableConfig', () => {
			it('should return compact config when in compact mode', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					colAligns: ['left', 'left', 'right', 'right', 'right'],
					compactHead: ['Date', 'Model', 'Cost'],
					compactColAligns: ['left', 'left', 'right'],
					forceCompact: true,
				});

				expect(table.toString()).toBeTypeOf('string');
				expect(table.isCompactMode()).toBe(true);
			});
		});
	});
}
