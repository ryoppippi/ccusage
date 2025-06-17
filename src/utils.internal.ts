import process from 'node:process';
import Table from 'cli-table3';
import pc from 'picocolors';
import stringWidth from 'string-width';

/**
 * Table row data type supporting strings, numbers, and formatted cell objects
 */
type TableRow = (string | number | { content: string; hAlign?: 'left' | 'right' | 'center' })[];
/**
 * Configuration options for creating responsive tables
 */
type TableOptions = {
	head: string[];
	colAligns?: ('left' | 'right' | 'center')[];
	style?: {
		head?: string[];
	};
	dateFormatter?: (dateStr: string) => string;
};

/**
 * Responsive table class that adapts column widths based on terminal size
 * Automatically adjusts formatting and layout for different screen sizes
 */
export class ResponsiveTable {
	private head: string[];
	private rows: TableRow[] = [];
	private colAligns: ('left' | 'right' | 'center')[];
	private style?: { head?: string[] };
	private dateFormatter?: (dateStr: string) => string;

	/**
	 * Creates a new responsive table instance
	 * @param options - Table configuration options
	 */
	constructor(options: TableOptions) {
		this.head = options.head;
		this.colAligns = options.colAligns ?? Array.from({ length: this.head.length }, () => 'left');
		this.style = options.style;
		this.dateFormatter = options.dateFormatter;
	}

	/**
	 * Adds a row to the table
	 * @param row - Row data to add
	 */
	push(row: TableRow): void {
		this.rows.push(row);
	}

	/**
	 * Renders the table as a formatted string
	 * Automatically adjusts layout based on terminal width
	 * @returns Formatted table string
	 */
	toString(): string {
		const terminalWidth = process.stdout.columns || 120;

		// Calculate actual content widths first (excluding separator rows)
		const dataRows = this.rows.filter(row => !this.isSeparatorRow(row));
		const allRows = [this.head.map(String), ...dataRows.map(row => row.map((cell) => {
			if (typeof cell === 'object' && cell != null && 'content' in cell) {
				return String(cell.content);
			}
			return String(cell ?? '');
		}))];
		const contentWidths = this.head.map((_, colIndex) => {
			const maxLength = Math.max(
				...allRows.map(row => stringWidth(String(row[colIndex] ?? ''))),
			);
			return maxLength;
		});

		// Calculate table overhead
		const numColumns = this.head.length;
		const tableOverhead = 3 * numColumns + 1; // borders and separators
		const availableWidth = terminalWidth - tableOverhead;

		// Always use content-based widths with generous padding for numeric columns
		const columnWidths = contentWidths.map((width, index) => {
			const align = this.colAligns[index];
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
				const align = this.colAligns[index];
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
				head: this.head,
				style: this.style,
				colAligns: this.colAligns,
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
					const processedRow = row.map((cell, index) => {
						if (index === 0 && this.dateFormatter != null && typeof cell === 'string' && this.isDateString(cell)) {
							return this.dateFormatter(cell);
						}
						return cell;
					});
					table.push(processedRow);
				}
			}

			return table.toString();
		}
		else {
			// Use generous column widths with normal date format
			const table = new Table({
				head: this.head,
				style: this.style,
				colAligns: this.colAligns,
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
					table.push(row);
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
	const uniqueModels = [...new Set(models.map(formatModelName))];
	return uniqueModels.sort().join(', ');
}

/**
 * Pushes model breakdown rows to a table
 * @param table - The table to push rows to
 * @param table.push - Method to add rows to the table
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

if (import.meta.vitest != null) {
	describe('formatNumber', () => {
		it('formats positive numbers with comma separators', () => {
			expect(formatNumber(1000)).toBe('1,000');
			expect(formatNumber(1000000)).toBe('1,000,000');
			expect(formatNumber(1234567.89)).toBe('1,234,567.89');
		});

		it('formats small numbers without separators', () => {
			expect(formatNumber(0)).toBe('0');
			expect(formatNumber(1)).toBe('1');
			expect(formatNumber(999)).toBe('999');
		});

		it('formats negative numbers', () => {
			expect(formatNumber(-1000)).toBe('-1,000');
			expect(formatNumber(-1234567.89)).toBe('-1,234,567.89');
		});

		it('formats decimal numbers', () => {
			expect(formatNumber(1234.56)).toBe('1,234.56');
			expect(formatNumber(0.123)).toBe('0.123');
		});

		it('handles edge cases', () => {
			expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
			expect(formatNumber(Number.MIN_SAFE_INTEGER)).toBe(
				'-9,007,199,254,740,991',
			);
		});
	});

	describe('formatCurrency', () => {
		it('formats positive amounts', () => {
			expect(formatCurrency(10)).toBe('$10.00');
			expect(formatCurrency(100.5)).toBe('$100.50');
			expect(formatCurrency(1234.56)).toBe('$1234.56');
		});

		it('formats zero', () => {
			expect(formatCurrency(0)).toBe('$0.00');
		});

		it('formats negative amounts', () => {
			expect(formatCurrency(-10)).toBe('$-10.00');
			expect(formatCurrency(-100.5)).toBe('$-100.50');
		});

		it('rounds to two decimal places', () => {
			expect(formatCurrency(10.999)).toBe('$11.00');
			expect(formatCurrency(10.994)).toBe('$10.99');
			expect(formatCurrency(10.995)).toBe('$10.99'); // JavaScript's toFixed uses banker's rounding
		});

		it('handles small decimal values', () => {
			expect(formatCurrency(0.01)).toBe('$0.01');
			expect(formatCurrency(0.001)).toBe('$0.00');
			expect(formatCurrency(0.009)).toBe('$0.01');
		});

		it('handles large numbers', () => {
			expect(formatCurrency(1000000)).toBe('$1000000.00');
			expect(formatCurrency(9999999.99)).toBe('$9999999.99');
		});
	});
}
