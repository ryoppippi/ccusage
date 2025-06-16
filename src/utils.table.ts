import process from 'node:process';
import Table from 'cli-table3';
import stringWidth from 'string-width';

type TableRow = (string | number)[];
type TableOptions = {
	head: string[];
	colAligns?: ('left' | 'right' | 'center')[];
	style?: {
		head?: string[];
	};
	dateFormatter?: (dateStr: string) => string;
};

export class ResponsiveTable {
	private head: string[];
	private rows: TableRow[] = [];
	private colAligns: ('left' | 'right' | 'center')[];
	private style?: { head?: string[] };
	private dateFormatter?: (dateStr: string) => string;

	constructor(options: TableOptions) {
		this.head = options.head;
		this.colAligns = options.colAligns ?? Array.from({ length: this.head.length }, () => 'left');
		this.style = options.style;
		this.dateFormatter = options.dateFormatter;
	}

	push(row: TableRow): void {
		this.rows.push(row);
	}

	toString(): string {
		const terminalWidth = process.stdout.columns || 120;

		// Calculate actual content widths first (excluding separator rows)
		const dataRows = this.rows.filter(row => !this.isSeparatorRow(row));
		const allRows = [this.head.map(String), ...dataRows.map(row => row.map(String))];
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

	private isSeparatorRow(row: TableRow): boolean {
		// Check for both old-style separator rows (─) and new-style empty rows
		return row.every(cell =>
			typeof cell === 'string'
			&& (cell === '' || /^─+$/.test(cell)),
		);
	}

	private isDateString(text: string): boolean {
		// Check if string matches date format YYYY-MM-DD
		return /^\d{4}-\d{2}-\d{2}$/.test(text);
	}
}
