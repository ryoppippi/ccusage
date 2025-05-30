import { describe, expect, test } from "bun:test";
import { formatCurrency, formatNumber } from "./utils.ts";

describe("formatNumber", () => {
	test("formats positive numbers with comma separators", () => {
		expect(formatNumber(1000)).toBe("1,000");
		expect(formatNumber(1000000)).toBe("1,000,000");
		expect(formatNumber(1234567.89)).toBe("1,234,567.89");
	});

	test("formats small numbers without separators", () => {
		expect(formatNumber(0)).toBe("0");
		expect(formatNumber(1)).toBe("1");
		expect(formatNumber(999)).toBe("999");
	});

	test("formats negative numbers", () => {
		expect(formatNumber(-1000)).toBe("-1,000");
		expect(formatNumber(-1234567.89)).toBe("-1,234,567.89");
	});

	test("formats decimal numbers", () => {
		expect(formatNumber(1234.56)).toBe("1,234.56");
		expect(formatNumber(0.123)).toBe("0.123");
	});

	test("handles edge cases", () => {
		expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe("9,007,199,254,740,991");
		expect(formatNumber(Number.MIN_SAFE_INTEGER)).toBe(
			"-9,007,199,254,740,991",
		);
	});
});

describe("formatCurrency", () => {
	test("formats positive amounts", () => {
		expect(formatCurrency(10, "USD")).toBe("$10.00");
		expect(formatCurrency(100.5, "USD")).toBe("$100.50");
		expect(formatCurrency(1234.56, "USD")).toBe("$1,234.56");
	});

	test("formats zero", () => {
		expect(formatCurrency(0, "USD")).toBe("$0.00");
	});

	test("formats negative amounts", () => {
		expect(formatCurrency(-10, "USD")).toBe("$-10.00");
		expect(formatCurrency(-100.5, "USD")).toBe("$-100.50");
	});

	test("rounds to two decimal places", () => {
		expect(formatCurrency(10.999, "USD")).toBe("$11.00");
		expect(formatCurrency(10.994, "USD")).toBe("$10.99");
		expect(formatCurrency(10.995, "USD")).toBe("$11.00"); // toLocaleString rounds differently than toFixed
	});

	test("handles small decimal values", () => {
		expect(formatCurrency(0.01, "USD")).toBe("$0.01");
		expect(formatCurrency(0.001, "USD")).toBe("$0.00");
		expect(formatCurrency(0.009, "USD")).toBe("$0.01");
	});

	test("handles large numbers", () => {
		expect(formatCurrency(1000000, "USD")).toBe("$1,000,000.00");
		expect(formatCurrency(9999999.99, "USD")).toBe("$9,999,999.99");
	});

	test("formats JPY currency with conversion", () => {
		// 1 USD = 150 JPY
		expect(formatCurrency(10, "JPY")).toBe("¥1,500");
		expect(formatCurrency(100.5, "JPY")).toBe("¥15,075");
		expect(formatCurrency(1234.56, "JPY")).toBe("¥185,184");
	});

	test("formats JPY with no decimals", () => {
		expect(formatCurrency(0.01, "JPY")).toBe("¥2"); // 0.01 * 150 = 1.5, rounds to 2
		expect(formatCurrency(0.001, "JPY")).toBe("¥0"); // 0.001 * 150 = 0.15, rounds to 0
		expect(formatCurrency(0.009, "JPY")).toBe("¥1"); // 0.009 * 150 = 1.35, rounds to 1
	});

	test("handles negative JPY amounts", () => {
		expect(formatCurrency(-10, "JPY")).toBe("¥-1,500");
		expect(formatCurrency(-100.5, "JPY")).toBe("¥-15,075");
	});
});
