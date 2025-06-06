import { beforeEach, describe, expect, it, vi } from "vitest";
import { CurrencyService } from "./currency.js";
import type { Currency } from "./types.js";

// Mock fetch globally
global.fetch = vi.fn();

describe("CurrencyService", () => {
	let currencyService: CurrencyService;

	beforeEach(() => {
		currencyService = new CurrencyService();
		vi.clearAllMocks();
	});

	describe("getExchangeRate", () => {
		it("should return 1 for USD", async () => {
			const rate = await currencyService.getExchangeRate("USD");
			expect(rate).toBe(1);
		});

		it("should fetch exchange rates from API", async () => {
			const mockResponse = {
				rates: {
					EUR: 0.85,
					IDR: 15000,
				},
			};

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			} as Response);

			const rate = await currencyService.getExchangeRate("EUR");
			expect(rate).toBe(0.85);
			expect(fetch).toHaveBeenCalledWith("https://api.exchangerate-api.com/v4/latest/USD");
		});

		it("should fallback to 1 if currency not found", async () => {
			const mockResponse = {
				rates: {
					EUR: 0.85,
				},
			};

			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve(mockResponse),
			} as Response);

			const rate = await currencyService.getExchangeRate("IDR");
			expect(rate).toBe(1);
		});

		it("should fallback to 1 on API error", async () => {
			vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

			const rate = await currencyService.getExchangeRate("EUR");
			expect(rate).toBe(1);
		});
	});

	describe("convertFromUSD", () => {
		it("should convert USD amounts to target currency", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: () => Promise.resolve({
					rates: { IDR: 15000 },
				}),
			} as Response);

			const converted = await currencyService.convertFromUSD(1, "IDR");
			expect(converted).toBe(15000);
		});

		it("should return same amount for USD", async () => {
			const converted = await currencyService.convertFromUSD(10.5, "USD");
			expect(converted).toBe(10.5);
		});
	});

	describe("getCurrencySymbol", () => {
		it("should return correct currency symbols", () => {
			expect(CurrencyService.getCurrencySymbol("USD")).toBe("$");
			expect(CurrencyService.getCurrencySymbol("EUR")).toBe("€");
			expect(CurrencyService.getCurrencySymbol("IDR")).toBe("Rp");
			expect(CurrencyService.getCurrencySymbol("JPY")).toBe("¥");
		});
	});

	describe("formatAmount", () => {
		it("should format amounts correctly", () => {
			expect(CurrencyService.formatAmount(10.5, "USD")).toBe("$10.50");
			expect(CurrencyService.formatAmount(15000, "IDR")).toBe("Rp15,000.00");
			expect(CurrencyService.formatAmount(100, "JPY")).toBe("¥100");
			expect(CurrencyService.formatAmount(1500, "KRW")).toBe("₩1,500");
		});
	});
});