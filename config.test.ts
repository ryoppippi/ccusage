import { beforeEach, describe, expect, test } from "bun:test";
import { getConfigPath, getCurrency, setCurrency } from "./config";

describe("config", () => {
	// Store original currency to restore after tests
	let originalCurrency: "USD" | "JPY";

	beforeEach(() => {
		// Save the current currency setting
		originalCurrency = getCurrency();
	});

	describe("getCurrency", () => {
		test("returns current currency setting", () => {
			const currency = getCurrency();
			expect(["USD", "JPY"]).toContain(currency);
		});
	});

	describe("setCurrency", () => {
		test("sets currency to USD", () => {
			setCurrency("USD");
			expect(getCurrency()).toBe("USD");
			// Restore original
			setCurrency(originalCurrency);
		});

		test("sets currency to JPY", () => {
			setCurrency("JPY");
			expect(getCurrency()).toBe("JPY");
			// Restore original
			setCurrency(originalCurrency);
		});

		test("throws error for invalid currency", () => {
			// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
			expect(() => setCurrency("EUR" as any)).toThrow(
				"Invalid currency: EUR. Must be USD or JPY.",
			);
		});

		test("persists currency setting", () => {
			setCurrency("JPY");
			expect(getCurrency()).toBe("JPY");

			setCurrency("USD");
			expect(getCurrency()).toBe("USD");

			// Restore original
			setCurrency(originalCurrency);
		});
	});

	describe("getConfigPath", () => {
		test("returns a valid config path", () => {
			const path = getConfigPath();
			expect(typeof path).toBe("string");
			expect(path.length).toBeGreaterThan(0);
			expect(path).toContain("ccusage");
		});
	});
});
