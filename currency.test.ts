import { describe, expect, test } from "bun:test";
import {
	convertFromUSD,
	formatCurrencyAmount,
	getCurrencyLabel,
} from "./currency";

describe("convertFromUSD", () => {
	test("converts USD to USD (no conversion)", () => {
		expect(convertFromUSD(100, "USD")).toBe(100);
		expect(convertFromUSD(0, "USD")).toBe(0);
		expect(convertFromUSD(-50, "USD")).toBe(-50);
	});

	test("converts USD to JPY at 1:150 rate", () => {
		expect(convertFromUSD(1, "JPY")).toBe(150);
		expect(convertFromUSD(100, "JPY")).toBe(15000);
		expect(convertFromUSD(0.5, "JPY")).toBe(75);
		expect(convertFromUSD(-10, "JPY")).toBe(-1500);
	});
});

describe("formatCurrencyAmount", () => {
	test("formats USD with 2 decimal places", () => {
		expect(formatCurrencyAmount(100, "USD")).toBe("$100.00");
		expect(formatCurrencyAmount(100.5, "USD")).toBe("$100.50");
		expect(formatCurrencyAmount(100.999, "USD")).toBe("$101.00");
		expect(formatCurrencyAmount(0, "USD")).toBe("$0.00");
	});

	test("formats JPY with 0 decimal places", () => {
		expect(formatCurrencyAmount(15000, "JPY")).toBe("¥15,000");
		expect(formatCurrencyAmount(15000.99, "JPY")).toBe("¥15,001");
		expect(formatCurrencyAmount(0, "JPY")).toBe("¥0");
		expect(formatCurrencyAmount(1.5, "JPY")).toBe("¥2");
	});

	test("handles negative amounts", () => {
		expect(formatCurrencyAmount(-100, "USD")).toBe("$-100.00");
		expect(formatCurrencyAmount(-15000, "JPY")).toBe("¥-15,000");
	});
});

describe("getCurrencyLabel", () => {
	test("returns correct labels for currencies", () => {
		expect(getCurrencyLabel("USD")).toBe("Cost (USD)");
		expect(getCurrencyLabel("JPY")).toBe("Cost (JPY)");
	});
});
