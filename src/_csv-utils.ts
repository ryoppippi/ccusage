/**
 * Escapes a value for CSV format
 * @param value - The value to escape
 * @returns Escaped value suitable for CSV
 */
export function escapeCsvValue(value: string | number | boolean | null | undefined): string {
	if (value == null) {
		return '';
	}

	const stringValue = String(value);

	// Check if the value needs to be quoted
	if (
		stringValue.includes(',')
		|| stringValue.includes('"')
		|| stringValue.includes('\n')
		|| stringValue.includes('\r')
	) {
		// Escape double quotes by doubling them
		const escaped = stringValue.replace(/"/g, '""');
		return `"${escaped}"`;
	}

	return stringValue;
}

/**
 * Converts an array of objects to CSV format
 * @param data - Array of objects to convert
 * @param headers - Optional custom headers (defaults to object keys)
 * @returns CSV string with headers and data
 */
export function arrayToCsv<T extends Record<string, unknown>>(
	data: readonly T[],
	headers?: readonly string[],
): string {
	if (data.length === 0) {
		return headers ? headers.join(',') : '';
	}

	// Use provided headers or extract from first object
	const firstItem = data[0];
	if (!firstItem) {
		return headers != null ? headers.join(',') : '';
	}
	const columnHeaders = headers ?? Object.keys(firstItem);

	// Create header row
	const headerRow = columnHeaders.map(escapeCsvValue).join(',');

	// Create data rows
	const dataRows = data.map((row) => {
		return columnHeaders
			.map((header) => {
				// If using custom headers, need to map them to object keys
				const key = headers != null ? Object.keys(firstItem)[columnHeaders.indexOf(header)] : header;
				const value = key != null ? row[key] : undefined;
				// Handle arrays by joining with semicolons
				if (Array.isArray(value)) {
					return escapeCsvValue(value.join(';'));
				}
				return escapeCsvValue(value as string | number | boolean | null | undefined);
			})
			.join(',');
	});

	return [headerRow, ...dataRows].join('\n');
}

/**
 * Formats a number as a decimal string with specified precision
 * @param value - Number to format
 * @param precision - Number of decimal places (default: 6)
 * @returns Formatted decimal string
 */
export function formatDecimal(value: number, precision = 6): string {
	return value.toFixed(precision);
}

/**
 * Formats a date for CSV output (ISO 8601 format)
 * @param date - Date to format
 * @returns ISO 8601 date string
 */
export function formatDateForCsv(date: Date): string {
	return date.toISOString().split('T')[0] ?? '';
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('escapeCsvValue', () => {
		it('should return empty string for null/undefined', () => {
			expect(escapeCsvValue(null)).toBe('');
			expect(escapeCsvValue(undefined)).toBe('');
		});

		it('should convert numbers and booleans to strings', () => {
			expect(escapeCsvValue(123)).toBe('123');
			expect(escapeCsvValue(true)).toBe('true');
			expect(escapeCsvValue(false)).toBe('false');
		});

		it('should not quote simple strings', () => {
			expect(escapeCsvValue('hello')).toBe('hello');
			expect(escapeCsvValue('test123')).toBe('test123');
		});

		it('should quote and escape strings with commas', () => {
			expect(escapeCsvValue('hello,world')).toBe('"hello,world"');
		});

		it('should quote and escape strings with quotes', () => {
			expect(escapeCsvValue('say "hello"')).toBe('"say ""hello"""');
		});

		it('should quote strings with newlines', () => {
			expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
			expect(escapeCsvValue('line1\r\nline2')).toBe('"line1\r\nline2"');
		});
	});

	describe('arrayToCsv', () => {
		it('should handle empty array', () => {
			expect(arrayToCsv([])).toBe('');
			expect(arrayToCsv([], ['col1', 'col2'])).toBe('col1,col2');
		});

		it('should convert simple objects', () => {
			const data = [
				{ name: 'Alice', age: 30 },
				{ name: 'Bob', age: 25 },
			];
			const expected = 'name,age\nAlice,30\nBob,25';
			expect(arrayToCsv(data)).toBe(expected);
		});

		it('should use custom headers', () => {
			const data = [
				{ name: 'Alice', age: 30 },
				{ name: 'Bob', age: 25 },
			];
			const expected = 'Name,Age\nAlice,30\nBob,25';
			expect(arrayToCsv(data, ['Name', 'Age'])).toBe(expected);
		});

		it('should handle arrays in values', () => {
			const data = [
				{ id: 1, tags: ['a', 'b', 'c'] },
				{ id: 2, tags: ['x', 'y'] },
			];
			const expected = 'id,tags\n1,a;b;c\n2,x;y';
			expect(arrayToCsv(data)).toBe(expected);
		});

		it('should handle special characters', () => {
			const data = [
				{ text: 'Hello, "world"', value: 'line1\nline2' },
			];
			const expected = 'text,value\n"Hello, ""world""","line1\nline2"';
			expect(arrayToCsv(data)).toBe(expected);
		});
	});

	describe('formatDecimal', () => {
		it('should format with default precision', () => {
			expect(formatDecimal(1.234567890)).toBe('1.234568');
			expect(formatDecimal(0.1)).toBe('0.100000');
		});

		it('should format with custom precision', () => {
			expect(formatDecimal(1.234567890, 2)).toBe('1.23');
			expect(formatDecimal(1.234567890, 8)).toBe('1.23456789');
		});
	});

	describe('formatDateForCsv', () => {
		it('should format date as ISO 8601', () => {
			const date = new Date('2024-01-15T12:34:56Z');
			expect(formatDateForCsv(date)).toBe('2024-01-15');
		});
	});
}
