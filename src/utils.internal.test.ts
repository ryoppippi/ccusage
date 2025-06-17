import { formatCurrency, formatNumber } from './utils.internal.ts';

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
