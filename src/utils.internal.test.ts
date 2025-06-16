import { describe, expect, test } from 'bun:test';
import {
	formatCurrency,
	formatDuration,
	formatNumber,
	get5HourWindowId,
	getWindowStartTime,
} from './utils.internal.ts';

describe('formatNumber', () => {
	test('formats positive numbers with comma separators', () => {
		expect(formatNumber(1000)).toBe('1,000');
		expect(formatNumber(1000000)).toBe('1,000,000');
		expect(formatNumber(1234567.89)).toBe('1,234,567.89');
	});

	test('formats small numbers without separators', () => {
		expect(formatNumber(0)).toBe('0');
		expect(formatNumber(1)).toBe('1');
		expect(formatNumber(999)).toBe('999');
	});

	test('formats negative numbers', () => {
		expect(formatNumber(-1000)).toBe('-1,000');
		expect(formatNumber(-1234567.89)).toBe('-1,234,567.89');
	});

	test('formats decimal numbers', () => {
		expect(formatNumber(1234.56)).toBe('1,234.56');
		expect(formatNumber(0.123)).toBe('0.123');
	});

	test('handles edge cases', () => {
		expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
		expect(formatNumber(Number.MIN_SAFE_INTEGER)).toBe(
			'-9,007,199,254,740,991',
		);
	});
});

describe('formatCurrency', () => {
	test('formats positive amounts', () => {
		expect(formatCurrency(10)).toBe('$10.00');
		expect(formatCurrency(100.5)).toBe('$100.50');
		expect(formatCurrency(1234.56)).toBe('$1234.56');
	});

	test('formats zero', () => {
		expect(formatCurrency(0)).toBe('$0.00');
	});

	test('formats negative amounts', () => {
		expect(formatCurrency(-10)).toBe('$-10.00');
		expect(formatCurrency(-100.5)).toBe('$-100.50');
	});

	test('rounds to two decimal places', () => {
		expect(formatCurrency(10.999)).toBe('$11.00');
		expect(formatCurrency(10.994)).toBe('$10.99');
		expect(formatCurrency(10.995)).toBe('$10.99'); // JavaScript's toFixed uses banker's rounding
	});

	test('handles small decimal values', () => {
		expect(formatCurrency(0.01)).toBe('$0.01');
		expect(formatCurrency(0.001)).toBe('$0.00');
		expect(formatCurrency(0.009)).toBe('$0.01');
	});

	test('handles large numbers', () => {
		expect(formatCurrency(1000000)).toBe('$1000000.00');
		expect(formatCurrency(9999999.99)).toBe('$9999999.99');
	});
});

describe('get5HourWindowId', () => {
	test('calculates correct window IDs for UTC timestamps', () => {
		expect(get5HourWindowId('2025-06-16T00:30:00Z')).toBe('2025-06-16-00');
		expect(get5HourWindowId('2025-06-16T05:00:00Z')).toBe('2025-06-16-05');
		expect(get5HourWindowId('2025-06-16T10:00:00Z')).toBe('2025-06-16-10');
		expect(get5HourWindowId('2025-06-16T15:00:00Z')).toBe('2025-06-16-15');
		expect(get5HourWindowId('2025-06-16T20:00:00Z')).toBe('2025-06-16-20');
	});

	test('handles window boundaries correctly', () => {
		expect(get5HourWindowId('2025-06-16T04:59:59Z')).toBe('2025-06-16-00');
		expect(get5HourWindowId('2025-06-16T05:00:00Z')).toBe('2025-06-16-05');
	});

	test('handles day boundaries correctly', () => {
		expect(get5HourWindowId('2025-06-16T23:30:00Z')).toBe('2025-06-16-20');
		expect(get5HourWindowId('2025-06-17T00:30:00Z')).toBe('2025-06-17-00');
	});
});

describe('getWindowStartTime', () => {
	test('correctly parses window ID to Date', () => {
		const windowId = '2025-06-16-15';
		const startTime = getWindowStartTime(windowId);
		expect(startTime.toISOString()).toBe('2025-06-16T15:00:00.000Z');
	});
});

describe('formatDuration', () => {
	test('formats durations correctly', () => {
		expect(formatDuration(0)).toBe('0m');
		expect(formatDuration(60000)).toBe('1m'); // 1 minute
		expect(formatDuration(3600000)).toBe('1h 0m'); // 1 hour
		expect(formatDuration(5400000)).toBe('1h 30m'); // 1.5 hours
		expect(formatDuration(18000000)).toBe('5h 0m'); // 5 hours
	});

	test('rounds down to nearest minute', () => {
		expect(formatDuration(61000)).toBe('1m'); // 1 minute 1 second
		expect(formatDuration(119999)).toBe('1m'); // 1 minute 59.999 seconds
	});
});
