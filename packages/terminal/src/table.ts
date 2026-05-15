import process from 'node:process';
import * as pc from '@ccusage/internal/colors';
import { getStringWidth } from './text-width.ts';

/**
 * Default locale used for date formatting when not specified
 * en-CA provides YYYY-MM-DD ISO format
 */
const DEFAULT_LOCALE = 'en-CA';
let numberFormatter: Intl.NumberFormat | undefined;
const formattedNumberCache = new Map<number, string>();
const formattedModelNameCache = new Map<string, string>();
const COLOR_RESET = '\x1B[39m';

function getNumberFormatter(): Intl.NumberFormat {
	numberFormatter ??= new Intl.NumberFormat('en-US');
	return numberFormatter;
}

function splitAnsiSequence(text: string, index: number): string | null {
	if (text.charCodeAt(index) !== 27 || text.charCodeAt(index + 1) !== 91) {
		return null;
	}
	let endIndex = index + 2;
	while (endIndex < text.length) {
		const code = text.charCodeAt(endIndex);
		if (code >= 64 && code <= 126) {
			return text.slice(index, endIndex + 1);
		}
		endIndex++;
	}
	return null;
}

function truncateToWidth(text: string, width: number): string {
	return truncateToWidthWithMeasuredWidth(text, width).text;
}

function truncateToWidthWithMeasuredWidth(
	text: string,
	width: number,
): {
	text: string;
	width: number;
} {
	const textWidth = getStringWidth(text);
	if (textWidth <= width) {
		return { text, width: textWidth };
	}
	if (width <= 1) {
		return { text: '…', width: 1 };
	}

	const targetWidth = width - 1;
	let visibleWidth = 0;
	let output = '';
	let hasAnsi = false;
	for (let index = 0; index < text.length; ) {
		const ansiSequence = splitAnsiSequence(text, index);
		if (ansiSequence != null) {
			output += ansiSequence;
			index += ansiSequence.length;
			hasAnsi = true;
			continue;
		}

		const codePoint = text.codePointAt(index);
		if (codePoint == null) {
			break;
		}
		const char = String.fromCodePoint(codePoint);
		const charWidth = codePoint < 0x80 ? 1 : getStringWidth(char);
		if (visibleWidth + charWidth > targetWidth) {
			break;
		}
		output += char;
		visibleWidth += charWidth;
		index += char.length;
	}

	return { text: `${output}…${hasAnsi ? COLOR_RESET : ''}`, width };
}

function padToWidth(text: string, width: number, align: TableCellAlign): string {
	const truncated = truncateToWidthWithMeasuredWidth(text, width);
	const padding = Math.max(0, width - truncated.width);
	switch (align) {
		case 'right':
			return `${' '.repeat(padding)}${truncated.text}`;
		case 'center': {
			const left = Math.floor(padding / 2);
			return `${' '.repeat(left)}${truncated.text}${' '.repeat(padding - left)}`;
		}
		case 'left':
			return `${truncated.text}${' '.repeat(padding)}`;
	}
}

function wrapHeaderLine(text: string, width: number): string[] {
	if (getStringWidth(text) <= width) {
		return [text];
	}

	const words = text.split(' ');
	if (words.length <= 1) {
		return [truncateToWidth(text, width)];
	}

	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current === '' ? word : `${current} ${word}`;
		if (getStringWidth(candidate) <= width) {
			current = candidate;
		} else {
			if (current !== '') {
				lines.push(current);
			}
			current = getStringWidth(word) <= width ? word : truncateToWidth(word, width);
		}
	}
	if (current !== '') {
		lines.push(current);
	}
	return lines;
}

function wrapCellLine(text: string, width: number): string[] {
	if (getStringWidth(text) <= width) {
		return [text];
	}

	const words = text.split(' ');
	if (words.length <= 1) {
		return [truncateToWidth(text, width)];
	}

	const lines: string[] = [];
	let current = '';
	for (const word of words) {
		const candidate = current === '' ? word : `${current} ${word}`;
		if (getStringWidth(candidate) <= width) {
			current = candidate;
			continue;
		}

		if (current !== '') {
			lines.push(current);
		}
		current =
			word === '' ? '' : getStringWidth(word) <= width ? word : truncateToWidth(word, width);
	}

	if (current !== '') {
		lines.push(current);
	}
	return lines.length === 0 ? [''] : lines;
}

function splitCellContent(content: string): string[] {
	return content.split('\n');
}

function stringifyCell(cell: TableRow[number] | undefined): string {
	if (typeof cell === 'object' && cell != null && 'content' in cell) {
		return String(cell.content);
	}
	return String(cell ?? '');
}

function formatDateParts(year: number, month: number, day: number): string {
	return `${year.toString().padStart(4, '0')}\n${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function createDatePartsFormatter(timezone: string | undefined): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
}

/**
 * Formats a date string to compact format with year on first line and month-day on second
 * @param dateStr - Input date string (YYYY-MM-DD or ISO timestamp)
 * @param timezone - Timezone to use for formatting (pass undefined to use system timezone)
 * @returns Formatted date string with newline separator (YYYY\nMM-DD)
 */
export function formatDateCompact(dateStr: string, timezone?: string): string {
	const isSimpleDateFormat = /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
	if (isSimpleDateFormat && (timezone == null || timezone === 'UTC')) {
		return `${dateStr.slice(0, 4)}\n${dateStr.slice(5)}`;
	}

	const date = isSimpleDateFormat
		? timezone != null
			? new Date(`${dateStr}T00:00:00Z`)
			: new Date(`${dateStr}T00:00:00`)
		: new Date(dateStr);
	if (timezone == null) {
		return formatDateParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
	}
	if (timezone === 'UTC') {
		return formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
	}

	const formatter = createDatePartsFormatter(timezone);
	const parts = formatter.formatToParts(date);
	const year = parts.find((p) => p.type === 'year')?.value ?? '';
	const month = parts.find((p) => p.type === 'month')?.value ?? '';
	const day = parts.find((p) => p.type === 'day')?.value ?? '';
	return `${year}\n${month}-${day}`;
}

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
	minColumnWidths?: number[];
	compactMinColumnWidths?: number[];
	flexibleColumnIndex?: number;
	compactFlexibleColumnIndex?: number;
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
	private dateFormatter?: (dateStr: string) => string;
	private compactHead?: string[];
	private compactColAligns?: TableCellAlign[];
	private minColumnWidths?: number[];
	private compactMinColumnWidths?: number[];
	private flexibleColumnIndex?: number;
	private compactFlexibleColumnIndex?: number;
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
		this.dateFormatter = options.dateFormatter;
		this.compactHead = options.compactHead;
		this.compactColAligns = options.compactColAligns;
		this.minColumnWidths = options.minColumnWidths;
		this.compactMinColumnWidths = options.compactMinColumnWidths;
		this.flexibleColumnIndex = options.flexibleColumnIndex;
		this.compactFlexibleColumnIndex = options.compactFlexibleColumnIndex;
		this.compactThreshold = options.compactThreshold ?? 100;
		this.forceCompact = options.forceCompact ?? false;
		this.logger = options.logger ?? console.warn;
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
		return compactIndices.map((index) => row[index] ?? '');
	}

	/**
	 * Gets the current table head and col aligns based on compact mode
	 * @returns Current head and colAligns arrays
	 */
	private getCurrentTableConfig(): {
		head: string[];
		colAligns: TableCellAlign[];
		minColumnWidths?: number[];
		flexibleColumnIndex?: number;
	} {
		if (this.compactMode && this.compactHead != null) {
			return {
				head: this.compactHead,
				colAligns:
					this.compactColAligns ??
					Array.from({ length: this.compactHead.length }, () => 'left' as const),
				minColumnWidths: this.compactMinColumnWidths,
				flexibleColumnIndex: this.compactFlexibleColumnIndex,
			};
		}
		return {
			head: this.head,
			colAligns: this.colAligns,
			minColumnWidths: this.minColumnWidths,
			flexibleColumnIndex: this.flexibleColumnIndex,
		};
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
				this.logger(
					`Warning: Compact header "${compactHeader}" not found in table headers [${this.head.join(', ')}]. Using first column as fallback.`,
				);
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
		const terminalWidth =
			process.stdout.columns || Number.parseInt(process.env.COLUMNS ?? '', 10) || 120;

		this.compactMode =
			this.forceCompact || (terminalWidth < this.compactThreshold && this.compactHead != null);

		for (;;) {
			const { head, colAligns, minColumnWidths, flexibleColumnIndex } =
				this.getCurrentTableConfig();
			const compactIndices = this.getCompactIndices();
			const dataRows = this.rows.filter((row) => !this.isSeparatorRow(row));
			const processedDataRows = this.compactMode
				? dataRows.map((row) => this.filterRowToCompact(row, compactIndices))
				: dataRows;

			const contentWidths = head.map((header) => getStringWidth(header));
			for (const row of processedDataRows) {
				for (let colIndex = 0; colIndex < head.length; colIndex++) {
					const width = Math.max(
						...splitCellContent(stringifyCell(row[colIndex])).map((line) => getStringWidth(line)),
					);
					if (width > contentWidths[colIndex]!) {
						contentWidths[colIndex] = width;
					}
				}
			}

			const numColumns = head.length;
			const tableOverhead = numColumns + 1;
			const availableWidth = terminalWidth - tableOverhead;
			const columnWidths = contentWidths.map((width, index) => {
				const align = colAligns[index];
				const minWidth = minColumnWidths?.[index];
				if (align === 'right') {
					return Math.max(width + 2, minWidth ?? 11);
				}
				if (index === flexibleColumnIndex) {
					return Math.max(width + 2, minWidth ?? 15);
				}
				return Math.max(width + 2, minWidth ?? 10);
			});

			let totalRequiredWidth = columnWidths.reduce((sum, width) => sum + width, 0) + tableOverhead;

			if (
				flexibleColumnIndex != null &&
				totalRequiredWidth > terminalWidth &&
				columnWidths[flexibleColumnIndex] != null
			) {
				const fixedWidth = columnWidths.reduce(
					(sum, width, index) => sum + (index === flexibleColumnIndex ? 0 : width),
					0,
				);
				const flexibleMinWidth = minColumnWidths?.[flexibleColumnIndex] ?? 12;
				const availableFlexibleWidth = Math.max(flexibleMinWidth, availableWidth - fixedWidth);
				columnWidths[flexibleColumnIndex] = Math.min(
					columnWidths[flexibleColumnIndex],
					availableFlexibleWidth,
				);
				totalRequiredWidth = columnWidths.reduce((sum, width) => sum + width, 0) + tableOverhead;
			}

			if (!this.compactMode && this.compactHead != null && totalRequiredWidth > terminalWidth) {
				this.compactMode = true;
				continue;
			}

			if (totalRequiredWidth <= terminalWidth) {
				return this.renderFastTable(
					head,
					colAligns,
					columnWidths,
					this.getRenderableRows(dataRows, compactIndices, false),
				);
			}

			const fixedMinimumWidth = columnWidths.reduce((sum, width, index) => {
				if (index === flexibleColumnIndex) {
					return sum;
				}
				return sum + Math.min(width, minColumnWidths?.[index] ?? width);
			}, 0);
			const lockedFlexibleWidth =
				flexibleColumnIndex == null
					? undefined
					: Math.max(
							minColumnWidths?.[flexibleColumnIndex] ?? 12,
							availableWidth - fixedMinimumWidth,
						);
			const adjustedTotalWidth = columnWidths.reduce((sum, width) => sum + width, 0);
			const scaleFactor = availableWidth / adjustedTotalWidth;
			const adjustedWidths = columnWidths.map((width, index) => {
				const align = colAligns[index];
				let adjustedWidth = Math.floor(width * scaleFactor);
				const minWidth = minColumnWidths?.[index];
				if (index === flexibleColumnIndex && lockedFlexibleWidth != null) {
					return Math.min(width, lockedFlexibleWidth);
				}

				if (align === 'right') {
					adjustedWidth = Math.max(adjustedWidth, minWidth ?? 10);
				} else if (index === 0) {
					adjustedWidth = Math.max(adjustedWidth, minWidth ?? 12);
				} else {
					adjustedWidth = Math.max(adjustedWidth, minWidth ?? 8);
				}

				return adjustedWidth;
			});

			return this.renderFastTable(
				head,
				colAligns,
				adjustedWidths,
				this.getRenderableRows(dataRows, compactIndices, true),
			);
		}
	}

	private getRenderableRows(
		rows: TableRow[],
		compactIndices: number[],
		applyDateFormatter: boolean,
	): TableRow[] {
		if (!this.compactMode && !applyDateFormatter) {
			return rows;
		}

		return rows.map((row) => {
			const processedRow = applyDateFormatter
				? row.map((cell, index) => {
						if (
							index === 0 &&
							this.dateFormatter != null &&
							typeof cell === 'string' &&
							this.isDateString(cell)
						) {
							return this.dateFormatter(cell);
						}
						return cell;
					})
				: row;

			return this.compactMode
				? this.filterRowToCompact(processedRow, compactIndices)
				: processedRow;
		});
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

	private renderFastTable(
		head: string[],
		colAligns: TableCellAlign[],
		colWidths: number[],
		rows: TableRow[] = this.rows.filter((row) => !this.isSeparatorRow(row)),
	): string {
		const innerWidths = colWidths.map((width) => Math.max(1, width - 2));
		const border = {
			top: this.renderBorder('┌', '┬', '┐', innerWidths),
			mid: this.renderBorder('├', '┼', '┤', innerWidths),
			bottom: this.renderBorder('└', '┴', '┘', innerWidths),
		};
		const output: string[] = [border.top];
		output.push(...this.renderFastRow(head, innerWidths, colAligns, true, false));
		output.push(border.mid);
		for (let index = 0; index < rows.length; index++) {
			output.push(
				...this.renderFastRow(rows[index]!, innerWidths, colAligns, false, this.compactMode),
			);
			output.push(index === rows.length - 1 ? border.bottom : border.mid);
		}
		return output.join('\n');
	}

	private renderBorder(left: string, middle: string, right: string, innerWidths: number[]): string {
		const segments = innerWidths.map((width) => '─'.repeat(width + 2));
		return pc.gray(`${left}${segments.join(middle)}${right}`);
	}

	private renderFastRow(
		row: TableRow,
		innerWidths: number[],
		colAligns: TableCellAlign[],
		isHeader: boolean,
		wrapCells: boolean,
	): string[] {
		const cellLines = innerWidths.map((width, index) => {
			const cell = row[index] ?? '';
			const content = stringifyCell(cell);
			const lines = isHeader
				? splitCellContent(content).flatMap((line) => wrapHeaderLine(line, width))
				: splitCellContent(content).flatMap((line) =>
						wrapCells ? wrapCellLine(line, width) : [line],
					);
			return lines.length === 0 ? [''] : lines;
		});
		const rowHeight = Math.max(...cellLines.map((lines) => lines.length));
		const lines: string[] = [];
		for (let lineIndex = 0; lineIndex < rowHeight; lineIndex++) {
			let line = pc.gray('│');
			for (let colIndex = 0; colIndex < innerWidths.length; colIndex++) {
				const cell = row[colIndex] ?? '';
				const align =
					typeof cell === 'object' && cell != null && 'content' in cell && cell.hAlign != null
						? cell.hAlign
						: (colAligns[colIndex] ?? 'left');
				const content = cellLines[colIndex]?.[lineIndex] ?? '';
				const padded = padToWidth(content, innerWidths[colIndex]!, align);
				line += isHeader ? pc.cyan(` ${padded} `) : ` ${padded} `;
				line += pc.gray('│');
			}
			lines.push(line);
		}
		return lines;
	}
}

/**
 * Formats a number with locale-specific thousand separators
 * @param num - The number to format
 * @returns Formatted number string with commas as thousand separators
 */
export function formatNumber(num: number): string {
	const cached = formattedNumberCache.get(num);
	if (cached != null) {
		return cached;
	}
	const formatted = getNumberFormatter().format(num);
	formattedNumberCache.set(num, formatted);
	return formatted;
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
 * @param modelName - Full model name (e.g., "claude-sonnet-4-20250514" or "claude-sonnet-4-5-20250929")
 * @returns Shortened model name (e.g., "sonnet-4" or "sonnet-4-5") or original if pattern doesn't match
 */
function formatModelName(modelName: string): string {
	const cached = formattedModelNameCache.get(modelName);
	if (cached != null) {
		return cached;
	}

	let formatted = modelName;
	// Handle [pi] prefix - preserve prefix, format the rest
	const piMatch = modelName.match(/^\[pi\] (.+)$/);
	if (piMatch?.[1] != null) {
		formatted = `[pi] ${formatModelName(piMatch[1])}`;
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	const providerMatch = modelName.match(/^(?:anthropic\/|anthropic\.)(claude-.+)$/);
	if (providerMatch?.[1] != null) {
		formatted = formatModelName(providerMatch[1]);
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	const legacyDatedMatch = modelName.match(/^claude-(\d+)-(\d+)-(\w+)-(\d{8})$/);
	if (legacyDatedMatch != null) {
		formatted = `${legacyDatedMatch[3]}-${legacyDatedMatch[1]}-${legacyDatedMatch[2]}`;
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	const datedFastMatch = modelName.match(/^claude-(\w+)-([\d-]+)-(\d{8})-fast$/);
	if (datedFastMatch != null) {
		formatted = `${datedFastMatch[1]}-${datedFastMatch[2]}-fast`;
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	// Extract model type from full model name with date suffix (must check before no-date pattern)
	// e.g., "claude-sonnet-4-20250514" -> "sonnet-4"
	// e.g., "claude-opus-4-20250514" -> "opus-4"
	// e.g., "claude-sonnet-4-5-20250929" -> "sonnet-4-5"
	const match = modelName.match(/^claude-(\w+)-([\d-]+)-(\d{8})$/);
	if (match != null) {
		formatted = `${match[1]}-${match[2]}`;
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	const fastMatch = modelName.match(/^claude-(\w+)-([\d.-]+)-fast$/);
	if (fastMatch != null) {
		formatted = `${fastMatch[1]}-${fastMatch[2]}-fast`;
		formattedModelNameCache.set(modelName, formatted);
		return formatted;
	}

	// Handle claude- without date suffix (e.g., "claude-opus-4-5" -> "opus-4-5")
	const noDateMatch = modelName.match(/^claude-(\w+)-([\d.-]+)$/);
	if (noDateMatch != null) {
		formatted = `${noDateMatch[1]}-${noDateMatch[2]}`;
	}

	formattedModelNameCache.set(modelName, formatted);
	return formatted;
}

/**
 * Formats an array of model names for display as a comma-separated string
 * Removes duplicates and sorts alphabetically
 * @param models - Array of model names
 * @returns Formatted string with unique, sorted model names separated by commas
 */
export function formatModelsDisplay(models: string[]): string {
	// Format array of models for display
	const uniqueModels = Array.from(new Set(models.map(formatModelName)));
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
	const uniqueModels = Array.from(new Set(models.map(formatModelName)));
	return uniqueModels
		.sort()
		.map((model) => `- ${model}`)
		.join('\n');
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
		const totalTokens =
			breakdown.inputTokens +
			breakdown.outputTokens +
			breakdown.cacheCreationTokens +
			breakdown.cacheReadTokens;

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
	/** Whether to include Agent column (for all-agent reports) */
	includeAgent?: boolean;
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
	agent?: string;
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
		'Cache Create',
		'Cache Read',
		'Total Tokens',
		'Cost (USD)',
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

	const minColumnWidths = [12, 18, 11, 11, 11, 11, 11, 14];
	const compactHeaders =
		config.includeAgent === true
			? [config.firstColumnName, 'Agent', 'Total Tokens', 'Cost (USD)']
			: [config.firstColumnName, 'Models', 'Input', 'Output', 'Cost (USD)'];
	const compactAligns: TableCellAlign[] =
		config.includeAgent === true
			? ['left', 'left', 'right', 'right']
			: ['left', 'left', 'right', 'right', 'right'];
	const compactMinColumnWidths =
		config.includeAgent === true ? [12, 10, 14, 14] : [12, 18, 11, 11, 14];

	if (config.includeAgent ?? false) {
		baseHeaders.splice(1, 0, 'Agent');
		baseAligns.splice(1, 0, 'left');
		minColumnWidths.splice(1, 0, 10);
	}

	// Add Last Activity column for session reports
	if (config.includeLastActivity ?? false) {
		baseHeaders.push('Last Activity');
		baseAligns.push('left');
		compactHeaders.push('Last Activity');
		compactAligns.push('left');
	}

	const flexibleColumnIndex = baseHeaders.indexOf('Models');
	const compactFlexibleColumnIndex = compactHeaders.indexOf('Models');

	return new ResponsiveTable({
		head: baseHeaders,
		style: { head: ['cyan'] },
		colAligns: baseAligns,
		dateFormatter: config.dateFormatter,
		compactHead: compactHeaders,
		compactColAligns: compactAligns,
		minColumnWidths,
		compactMinColumnWidths,
		flexibleColumnIndex: flexibleColumnIndex === -1 ? undefined : flexibleColumnIndex,
		compactFlexibleColumnIndex:
			compactFlexibleColumnIndex === -1 ? undefined : compactFlexibleColumnIndex,
		compactThreshold: 100,
		forceCompact: config.forceCompact,
	});
}

/**
 * Formats a usage data row for display in the table
 * @param firstColumnValue - Value for the first column (date, month, etc.)
 * @param data - Usage data containing tokens and cost information
 * @param lastActivity - Optional last activity value (for session reports)
 * @returns Formatted table row
 */
export function formatUsageDataRow(
	firstColumnValue: string,
	data: UsageData,
	lastActivity?: string,
): (string | number)[] {
	const totalTokens =
		data.inputTokens + data.outputTokens + data.cacheCreationTokens + data.cacheReadTokens;

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

	if (data.agent != null) {
		row.splice(1, 0, data.agent);
	}

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
export function formatTotalsRow(
	totals: UsageData,
	includeLastActivity = false,
	includeAgent = false,
): (string | number)[] {
	const totalTokens =
		totals.inputTokens + totals.outputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;

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

	if (includeAgent) {
		row.splice(1, 0, '');
	}

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
	describe('createUsageReportTable', () => {
		it('shortens Claude-style model names from agent wrappers', () => {
			expect(formatModelsDisplayMultiline(['claude-3-5-haiku-20241022'])).toBe('- haiku-3-5');
			expect(formatModelsDisplayMultiline(['claude-opus-4-6-fast'])).toBe('- opus-4-6-fast');
			expect(formatModelsDisplayMultiline(['claude-opus-4-20250514-fast'])).toBe('- opus-4-fast');
			expect(formatModelsDisplayMultiline(['anthropic/claude-sonnet-4-6'])).toBe('- sonnet-4-6');
		});

		it('uses total tokens and cost only for compact all-agent usage tables', () => {
			vi.stubEnv('COLUMNS', '80');
			try {
				const table = createUsageReportTable({
					firstColumnName: 'Date',
					includeAgent: true,
					dateFormatter: (date) => date,
				});
				table.push(
					formatUsageDataRow('2026-03-01', {
						agent: 'All',
						modelsUsed: ['very-long-model-name-that-should-not-define-the-compact-width'],
						inputTokens: 1_000_000,
						outputTokens: 500_000,
						cacheCreationTokens: 200_000,
						cacheReadTokens: 300_000,
						totalCost: 12_345.67,
					}),
				);

				const output = table.toString();
				expect(output).toContain('Total Tokens');
				expect(output).toContain('$12345.67');
				expect(output).not.toContain('Models');
				expect(output).not.toContain('Input');
				expect(output).not.toContain('Output');
				expect(output).not.toContain('very-long-model-name');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('keeps rendered all-agent table lines within the terminal width', () => {
			vi.stubEnv('COLUMNS', '120');
			try {
				const table = createUsageReportTable({
					firstColumnName: 'Date',
					includeAgent: true,
					dateFormatter: (date) => date,
				});
				table.push(
					formatUsageDataRow('2026-03-01', {
						agent: 'All',
						modelsUsed: ['very-long-model-name-that-should-wrap-before-numeric-columns'],
						inputTokens: 987_654_321,
						outputTokens: 123_456_789,
						cacheCreationTokens: 456_789_123,
						cacheReadTokens: 789_123_456,
						totalCost: 15_990.3,
					}),
				);
				table.push(
					formatUsageDataRow('', {
						agent: '  └─ Claude',
						modelsUsed: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514'],
						inputTokens: 111_111_111,
						outputTokens: 222_222,
						cacheCreationTokens: 333_333,
						cacheReadTokens: 444_444,
						totalCost: 423.62,
					}),
				);

				const output = table.toString();
				for (const line of output.split('\n')) {
					expect(getStringWidth(line)).toBeLessThanOrEqual(120);
				}
				expect(table.isCompactMode()).toBe(true);
				expect(output).toContain('Total Tokens');
				expect(output).toContain('$15990.30');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('keeps the full all-agent table in wide terminals by shrinking the models column', () => {
			vi.stubEnv('COLUMNS', '300');
			try {
				const table = createUsageReportTable({
					firstColumnName: 'Date',
					includeAgent: true,
					dateFormatter: (date) => date,
				});
				table.push(
					formatUsageDataRow('2026-03-01', {
						agent: 'All',
						modelsUsed: [
							'gpt-5.3-codex-spark',
							'gpt-5.4',
							'claude-opus-4-6-fast',
							'haiku-4-5',
							'opus-4-6',
							'sonnet-4-6',
						],
						inputTokens: 43_049_344_123,
						outputTokens: 687_753,
						cacheCreationTokens: 3_456_789,
						cacheReadTokens: 987_654_321,
						totalCost: 15_990.3,
					}),
				);

				const output = table.toString();
				expect(table.isCompactMode()).toBe(false);
				expect(output).toContain('Models');
				expect(output).toContain('Cache Create');
				expect(output).toContain('$15990.30');
				for (const line of output.split('\n')) {
					expect(getStringWidth(line)).toBeLessThanOrEqual(300);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('supports agent rows while keeping compact dates and costs readable', () => {
			vi.stubEnv('COLUMNS', '80');
			try {
				const table = createUsageReportTable({
					firstColumnName: 'Date',
					includeAgent: true,
					dateFormatter: (date) => date,
				});
				table.push(
					formatUsageDataRow('2026-03-01', {
						agent: 'Claude\nCodex',
						modelsUsed: ['very-long-model-name-that-can-shrink-first'],
						inputTokens: 1_000_000,
						outputTokens: 500_000,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 12_345.67,
					}),
				);

				const output = table.toString();
				expect(output).toContain('2026-03-01');
				expect(output).toContain('$12345.67');
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	describe('ResponsiveTable', () => {
		describe('compact mode behavior', () => {
			it('keeps full columns when the rendered full layout fits the terminal width', () => {
				vi.stubEnv('COLUMNS', '145');
				try {
					const table = new ResponsiveTable({
						head: [
							'Date',
							'Models',
							'Input',
							'Output',
							'Cache Create',
							'Cache Read',
							'Total Tokens',
							'Credits',
							'Cost (USD)',
						],
						colAligns: [
							'left',
							'left',
							'right',
							'right',
							'right',
							'right',
							'right',
							'right',
							'right',
						],
						compactHead: ['Date', 'Models', 'Input', 'Output', 'Credits', 'Cost (USD)'],
						compactColAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
						compactThreshold: 40,
						minColumnWidths: [12, 14, 11, 11, 11, 11, 11, 9, 14],
						compactMinColumnWidths: [12, 14, 11, 11, 9, 14],
						flexibleColumnIndex: 1,
						compactFlexibleColumnIndex: 1,
					});

					table.push([
						'2025-11-23',
						'- haiku-3-5\n- haiku-4-5',
						'608',
						'469',
						'24,411',
						'0',
						'25,488',
						'3.33',
						'$0.03',
					]);

					const output = table.toString();
					expect(table.isCompactMode()).toBe(false);
					expect(output).toContain('Cache Create');
					expect(output).toContain('Cache Read');
					expect(output).toContain('Total Tokens');
					for (const line of output.split('\n')) {
						expect(getStringWidth(line)).toBeLessThanOrEqual(145);
					}
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('does not compact because of border width already included in column widths', () => {
				vi.stubEnv('COLUMNS', '35');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Cost'],
						colAligns: ['left', 'left', 'right'],
						compactHead: ['Date', 'Cost'],
						compactColAligns: ['left', 'right'],
						compactThreshold: 1,
						minColumnWidths: [10, 10, 10],
						compactMinColumnWidths: [10, 10],
					});

					table.push(['2026-05', 'gpt-5', '$1.23']);

					const output = table.toString();
					expect(table.isCompactMode()).toBe(false);
					expect(output).toContain('Model');
					for (const line of output.split('\n')) {
						expect(getStringWidth(line)).toBeLessThanOrEqual(35);
					}
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('sizes multiline cells by their widest line', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Models', 'Cost'],
						colAligns: ['left', 'left', 'right'],
						minColumnWidths: [12, 14, 12],
					});

					table.push(['2025-11-23', '- haiku-3-5\n- haiku-4-5', '$0.03']);

					const output = table.toString();
					expect(output.split('\n')[0]).toBe('┌────────────┬──────────────┬────────────┐');
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should activate compact mode when terminal width is below threshold', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(true);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should not activate compact mode when terminal width is above threshold', () => {
				vi.stubEnv('COLUMNS', '120');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(false);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should prefer the current stdout width over a stale COLUMNS value', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactHead: ['Date', 'Model', 'Cost'],
					compactThreshold: 100,
				});

				const originalDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
				vi.stubEnv('COLUMNS', '80');
				Object.defineProperty(process.stdout, 'columns', {
					configurable: true,
					value: 140,
				});

				try {
					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(false);
				} finally {
					vi.unstubAllEnvs();
					if (originalDescriptor != null) {
						Object.defineProperty(process.stdout, 'columns', originalDescriptor);
					} else {
						Reflect.deleteProperty(process.stdout, 'columns');
					}
				}
			});

			it('should not activate compact mode when compactHead is not provided', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(false);
				} finally {
					vi.unstubAllEnvs();
				}
			});
		});

		describe('getCurrentTableConfig', () => {
			it('should return compact config when in compact mode', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						colAligns: ['left', 'left', 'right', 'right', 'right'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactColAligns: ['left', 'left', 'right'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
					const config = (table as any).getCurrentTableConfig();
					// eslint-disable-next-line ts/no-unsafe-member-access
					expect(config.head).toEqual(['Date', 'Model', 'Cost']);
					// eslint-disable-next-line ts/no-unsafe-member-access
					expect(config.colAligns).toEqual(['left', 'left', 'right']);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should return compact config with default aligns when compact aligns are omitted', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						colAligns: ['left', 'left', 'right', 'right', 'right'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					const output = table.toString();

					expect(output).toContain('Model');
					expect(output).not.toContain('Input');
					expect(output).not.toContain('Output');
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should return normal config when not in compact mode', () => {
				vi.stubEnv('COLUMNS', '120');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						colAligns: ['left', 'left', 'right', 'right', 'right'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactColAligns: ['left', 'left', 'right'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
					const config = (table as any).getCurrentTableConfig();
					// eslint-disable-next-line ts/no-unsafe-member-access
					expect(config.head).toEqual(['Date', 'Model', 'Input', 'Output', 'Cost']);
					// eslint-disable-next-line ts/no-unsafe-member-access
					expect(config.colAligns).toEqual(['left', 'left', 'right', 'right', 'right']);
				} finally {
					vi.unstubAllEnvs();
				}
			});
		});

		describe('getCompactIndices', () => {
			it('should return correct indices for existing compact headers', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
					const indices = (table as any).getCompactIndices();
					expect(indices).toEqual([0, 1, 4]);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should fallback to first column for non-existent headers and log warning', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const mockLogger = vi.fn();
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'NonExistent', 'Cost'],
						compactThreshold: 100,
						logger: mockLogger,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
					const indices = (table as any).getCompactIndices();
					expect(indices).toEqual([0, 0, 4]);
					expect(mockLogger).toHaveBeenCalledWith(
						'Warning: Compact header "NonExistent" not found in table headers [Date, Model, Input, Output, Cost]. Using first column as fallback.',
					);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should return all indices when not in compact mode', () => {
				vi.stubEnv('COLUMNS', '120');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Model', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
					const indices = (table as any).getCompactIndices();
					expect(indices).toEqual([0, 1, 2, 3, 4]);
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should return all indices when compactHead is null', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactThreshold: 100,
				});

				// Access private method for testing
				// eslint-disable-next-line ts/no-unsafe-assignment, ts/no-unsafe-call, ts/no-unsafe-member-access
				const indices = (table as any).getCompactIndices();
				expect(indices).toEqual([0, 1, 2, 3, 4]); // All columns
			});
		});

		describe('toString with mocked terminal widths', () => {
			it('should filter columns in compact mode', () => {
				vi.stubEnv('COLUMNS', '80');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					const output = table.toString();

					expect(table.isCompactMode()).toBe(true);
					expect(output).toContain('Date');
					expect(output).toContain('Cost');
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should show all columns in normal mode', () => {
				vi.stubEnv('COLUMNS', '150');
				try {
					const table = new ResponsiveTable({
						head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
						compactHead: ['Date', 'Cost'],
						compactThreshold: 100,
					});

					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					const output = table.toString();

					expect(output).toContain('Date');
					expect(output).toContain('Model');
					expect(output).toContain('Input');
					expect(output).toContain('Output');
					expect(output).toContain('Cost');
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it('should handle process.stdout.columns fallback when COLUMNS env var is not set', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactHead: ['Date', 'Cost'],
					compactThreshold: 100,
				});

				const originalStdoutColumns = process.stdout.columns;

				vi.stubEnv('COLUMNS', undefined);
				// eslint-disable-next-line ts/no-unsafe-member-access
				(process.stdout as any).columns = 80;

				try {
					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(true);
				} finally {
					vi.unstubAllEnvs();
					process.stdout.columns = originalStdoutColumns;
				}
			});

			it('should use default width when both COLUMNS and process.stdout.columns are unavailable', () => {
				const table = new ResponsiveTable({
					head: ['Date', 'Model', 'Input', 'Output', 'Cost'],
					compactHead: ['Date', 'Cost'],
					compactThreshold: 100,
				});

				const originalStdoutColumns = process.stdout.columns;

				vi.stubEnv('COLUMNS', undefined);
				// eslint-disable-next-line ts/no-unsafe-member-access
				(process.stdout as any).columns = undefined;

				try {
					table.push(['2024-01-01', 'sonnet-4', '1000', '500', '$1.50']);
					table.toString();

					expect(table.isCompactMode()).toBe(false);
				} finally {
					vi.unstubAllEnvs();
					process.stdout.columns = originalStdoutColumns;
				}
			});
		});
	});

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
			expect(formatNumber(Number.MIN_SAFE_INTEGER)).toBe('-9,007,199,254,740,991');
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

	describe('formatModelsDisplayMultiline', () => {
		it('formats single model with bullet point', () => {
			expect(formatModelsDisplayMultiline(['claude-sonnet-4-20250514'])).toBe('- sonnet-4');
		});

		it('formats multiple models with newlines and bullet points', () => {
			const models = ['claude-sonnet-4-20250514', 'claude-opus-4-20250514'];
			expect(formatModelsDisplayMultiline(models)).toBe('- opus-4\n- sonnet-4');
		});

		it('removes duplicates and sorts with bullet points', () => {
			const models = [
				'claude-sonnet-4-20250514',
				'claude-opus-4-20250514',
				'claude-sonnet-4-20250514',
			];
			expect(formatModelsDisplayMultiline(models)).toBe('- opus-4\n- sonnet-4');
		});

		it('handles empty array', () => {
			expect(formatModelsDisplayMultiline([])).toBe('');
		});

		it('handles models that do not match pattern with bullet points', () => {
			const models = ['custom-model', 'claude-sonnet-4-20250514'];
			expect(formatModelsDisplayMultiline(models)).toBe('- custom-model\n- sonnet-4');
		});

		it('formats Claude 4.5 models correctly', () => {
			expect(formatModelsDisplayMultiline(['claude-sonnet-4-5-20250929'])).toBe('- sonnet-4-5');
		});

		it('formats mixed model versions', () => {
			const models = [
				'claude-sonnet-4-20250514',
				'claude-sonnet-4-5-20250929',
				'claude-opus-4-1-20250805',
			];
			expect(formatModelsDisplayMultiline(models)).toBe('- opus-4-1\n- sonnet-4\n- sonnet-4-5');
		});

		it('formats pi-agent prefixed models', () => {
			expect(formatModelsDisplayMultiline(['[pi] claude-opus-4-5'])).toBe('- [pi] opus-4-5');
		});

		it('formats anthropic/ prefixed models with dot notation', () => {
			expect(formatModelsDisplayMultiline(['anthropic/claude-opus-4.5'])).toBe('- opus-4.5');
		});

		it('formats models without date suffix', () => {
			expect(formatModelsDisplayMultiline(['claude-opus-4-5'])).toBe('- opus-4-5');
			expect(formatModelsDisplayMultiline(['claude-haiku-4-5'])).toBe('- haiku-4-5');
		});

		it('formats pi-agent model with anthropic prefix', () => {
			expect(formatModelsDisplayMultiline(['[pi] anthropic/claude-opus-4.5'])).toBe(
				'- [pi] opus-4.5',
			);
		});
	});

	describe('formatDateCompact', () => {
		it('should format date to compact format with newline', () => {
			const result = formatDateCompact('2024-08-04');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle timezone parameter', () => {
			const result = formatDateCompact('2024-08-04T12:00:00Z', 'UTC');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle YYYY-MM-DD format dates', () => {
			const result = formatDateCompact('2024-08-04');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle timezone with YYYY-MM-DD format', () => {
			const result = formatDateCompact('2024-08-04', 'UTC');
			expect(result).toBe('2024\n08-04');
		});

		it('should handle non-UTC timezone with YYYY-MM-DD format', () => {
			const result = formatDateCompact('2024-08-04', 'America/New_York');
			expect(result).toBe('2024\n08-03');
		});

		it('should use default locale when not specified', () => {
			const result = formatDateCompact('2024-08-04');
			expect(result).toBe('2024\n08-04');
		});
	});
}
