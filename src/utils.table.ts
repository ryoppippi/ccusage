import process from 'node:process';
import Table from 'cli-table3';

type TableRow = (string | number)[];
type TableOptions = {
	head: string[];
	colAligns?: ('left' | 'right' | 'center')[];
	style?: {
		head?: string[];
	};
};

export class ResponsiveTable {
	private head: string[];
	private rows: TableRow[] = [];
	private colAligns: ('left' | 'right' | 'center')[];
	private style?: { head?: string[] };

	constructor(options: TableOptions) {
		this.head = options.head;
		this.colAligns = options.colAligns ?? Array.from({ length: this.head.length }, () => 'left');
		this.style = options.style;
	}

	push(row: TableRow): void {
		this.rows.push(row);
	}

	toString(): string {
		const terminalWidth = process.stdout.columns || 120;

		// Calculate reasonable column widths for responsive layout
		const numColumns = this.head.length;
		const tableOverhead = 3 * numColumns + 1; // borders and separators
		const availableWidth = terminalWidth - tableOverhead;

		// Create proportional column widths, with minimums
		const baseWidth = Math.floor(availableWidth / numColumns);
		const columnWidths = this.head.map((_, index) => {
			const align = this.colAligns[index];
			// Give wider columns to text content, narrower to numbers
			if (align === 'right') {
				// Numeric columns - smaller width
				return Math.max(Math.floor(baseWidth * 0.7), 8);
			}
			else if (index === 0) {
				// First column (Date/Session) - medium width
				return Math.max(Math.floor(baseWidth * 0.8), 10);
			}
			else if (index === 1) {
				// Models column - can be longer, needs more space
				return Math.max(Math.floor(baseWidth * 1.2), 12);
			}
			else {
				// Other columns - standard width
				return Math.max(baseWidth, 8);
			}
		});

		// Create table with responsive column widths and word wrapping
		const table = new Table({
			head: this.head,
			style: this.style,
			colAligns: this.colAligns,
			colWidths: columnWidths,
			wordWrap: true,
			wrapOnWordBoundary: true,
		});

		// Add all rows to the table
		for (const row of this.rows) {
			table.push(row);
		}

		return table.toString();
	}
}
