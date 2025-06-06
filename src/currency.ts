import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Currency, ExchangeRate } from "./types.js";
import { logger } from "./logger.js";

const CACHE_DIR = join(homedir(), ".claude");
const CACHE_FILE = join(CACHE_DIR, "exchange-rates.json");
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
const API_URL = "https://api.exchangerate-api.com/v4/latest/USD";

interface CachedRates {
	[currency: string]: ExchangeRate;
}

export class CurrencyService {
	private cachedRates: CachedRates = {};

	async getExchangeRate(targetCurrency: Currency): Promise<number> {
		if (targetCurrency === "USD") {
			return 1;
		}

		// Try to load from cache first
		await this.loadCache();

		const cached = this.cachedRates[targetCurrency];
		if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
			logger.debug(`Using cached exchange rate for ${targetCurrency}: ${cached.rate}`);
			return cached.rate;
		}

		// Fetch fresh rates
		try {
			const rates = await this.fetchExchangeRates();
			const rate = rates[targetCurrency];
			
			if (!rate) {
				logger.error(`Exchange rate not found for currency: ${targetCurrency}`);
				return 1; // Fallback to USD
			}

			// Cache the rate
			this.cachedRates[targetCurrency] = {
				currency: targetCurrency,
				rate,
				timestamp: Date.now(),
			};

			await this.saveCache();
			logger.debug(`Fetched fresh exchange rate for ${targetCurrency}: ${rate}`);
			return rate;
		} catch (error) {
			logger.error(`Failed to fetch exchange rates: ${error}`);
			
			// Try to use stale cached rate as fallback
			if (cached) {
				logger.warn(`Using stale cached rate for ${targetCurrency}: ${cached.rate}`);
				return cached.rate;
			}
			
			// Ultimate fallback to USD
			logger.warn(`No cached rate available, falling back to USD`);
			return 1;
		}
	}

	async convertFromUSD(usdAmount: number, targetCurrency: Currency): Promise<number> {
		const rate = await this.getExchangeRate(targetCurrency);
		return usdAmount * rate;
	}

	private async fetchExchangeRates(): Promise<Record<string, number>> {
		const response = await fetch(API_URL);
		
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		
		if (!data.rates || typeof data.rates !== "object") {
			throw new Error("Invalid response format from exchange rate API");
		}

		return data.rates;
	}

	private async loadCache(): Promise<void> {
		try {
			const data = await readFile(CACHE_FILE, "utf-8");
			this.cachedRates = JSON.parse(data);
		} catch (error) {
			// Cache file doesn't exist or is invalid, start with empty cache
			this.cachedRates = {};
		}
	}

	private async saveCache(): Promise<void> {
		try {
			await mkdir(CACHE_DIR, { recursive: true });
			await writeFile(CACHE_FILE, JSON.stringify(this.cachedRates, null, 2));
		} catch (error) {
			logger.error(`Failed to save exchange rate cache: ${error}`);
		}
	}

	static getCurrencySymbol(currency: Currency): string {
		const symbols: Record<Currency, string> = {
			USD: "$",
			EUR: "€",
			GBP: "£",
			JPY: "¥",
			CAD: "C$",
			AUD: "A$",
			CHF: "CHF",
			CNY: "¥",
			INR: "₹",
			IDR: "Rp",
			SGD: "S$",
			HKD: "HK$",
			KRW: "₩",
			MXN: "$",
			BRL: "R$",
			ZAR: "R",
			SEK: "kr",
			NOK: "kr",
			DKK: "kr",
			PLN: "zł",
		};
		return symbols[currency] || currency;
	}

	static formatAmount(amount: number, currency: Currency): string {
		const symbol = this.getCurrencySymbol(currency);
		
		// Format based on currency conventions
		if (currency === "JPY" || currency === "KRW") {
			// No decimal places for these currencies
			return `${symbol}${Math.round(amount).toLocaleString()}`;
		}
		
		if (currency === "IDR") {
			// Indonesian Rupiah: Use dots as thousand separators, no decimal places for whole amounts
			const rounded = Math.round(amount);
			const formatted = rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
			return `${symbol}${formatted}`;
		}
		
		return `${symbol}${amount.toFixed(2)}`;
	}
}

export const currencyService = new CurrencyService();