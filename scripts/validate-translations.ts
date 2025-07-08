#!/usr/bin/env node

/**
 * Translation completeness validation script
 * Checks that all translation files are complete and consistent
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

// Simple ANSI color codes
const colors = {
	reset: '\x1B[0m',
	bold: '\x1B[1m',
	red: '\x1B[31m',
	green: '\x1B[32m',
	yellow: '\x1B[33m',
	blue: '\x1B[34m',
};

type ValidationResult = {
	locale: string;
	valid: boolean;
	errors: string[];
	warnings: string[];
	stats: {
		totalKeys: number;
		fileSize: number;
		emptyValues: number;
		missingKeys: number;
		extraKeys: number;
	};
};

class TranslationValidator {
	private localesDir: string;
	private englishTranslations: Record<string, unknown>;
	private allLocales: string[];

	constructor() {
		this.localesDir = join(process.cwd(), 'locales');
		this.englishTranslations = this.loadEnglishReference();
		this.allLocales = this.discoverLocales();
	}

	/**
	 * Loads the English translations as reference
	 */
	private loadEnglishReference(): Record<string, unknown> {
		try {
			const englishPath = join(this.localesDir, 'en.json');
			const content = readFileSync(englishPath, 'utf-8');
			return JSON.parse(content) as Record<string, unknown>;
		}
		catch {
			console.error(`${colors.red}❌ Unable to load English reference file${colors.reset}`);
			process.exit(1);
		}
	}

	/**
	 * Discovers all available locale files
	 */
	private discoverLocales(): string[] {
		try {
			return readdirSync(this.localesDir)
				.filter(file => file.endsWith('.json'))
				.map(file => file.replace('.json', ''))
				.sort();
		}
		catch {
			console.error(`${colors.red}❌ Unable to read locales directory${colors.reset}`);
			process.exit(1);
		}
	}

	/**
	 * Recursively extracts all keys from an object
	 */
	private getAllKeys(obj: Record<string, unknown>, prefix = ''): string[] {
		const keys: string[] = [];
		for (const [key, value] of Object.entries(obj)) {
			const fullKey = prefix !== '' ? `${prefix}.${key}` : key;
			if (typeof value === 'object' && value !== null) {
				keys.push(...this.getAllKeys(value as Record<string, unknown>, fullKey));
			}
			else {
				keys.push(fullKey);
			}
		}
		return keys.sort();
	}

	/**
	 * Recursively counts all keys
	 */
	private countKeys(obj: Record<string, unknown>): number {
		let count = 0;
		for (const value of Object.values(obj)) {
			if (typeof value === 'object' && value !== null) {
				count += this.countKeys(value as Record<string, unknown>);
			}
			else {
				count += 1;
			}
		}
		return count;
	}

	/**
	 * Finds empty values
	 */
	private findEmptyValues(obj: Record<string, unknown>, prefix = ''): string[] {
		const empty: string[] = [];
		for (const [key, value] of Object.entries(obj)) {
			const fullKey = prefix !== '' ? `${prefix}.${key}` : key;
			if (typeof value === 'object' && value !== null) {
				empty.push(...this.findEmptyValues(value as Record<string, unknown>, fullKey));
			}
			else if (typeof value === 'string' && value.trim() === '') {
				empty.push(fullKey);
			}
		}
		return empty;
	}

	/**
	 * Validates a specific translation file
	 */
	private validateLocale(locale: string): ValidationResult {
		const result: ValidationResult = {
			locale,
			valid: true,
			errors: [],
			warnings: [],
			stats: {
				totalKeys: 0,
				fileSize: 0,
				emptyValues: 0,
				missingKeys: 0,
				extraKeys: 0,
			},
		};

		try {
			const filePath = join(this.localesDir, `${locale}.json`);

			// Check if file exists
			try {
				result.stats.fileSize = statSync(filePath).size;
			}
			catch {
				result.errors.push(`File ${locale}.json not found`);
				result.valid = false;
				return result;
			}

			// Load and parse JSON
			let translations: Record<string, unknown>;
			try {
				const content = readFileSync(filePath, 'utf-8');
				translations = JSON.parse(content) as Record<string, unknown>;
			}
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.errors.push(`Invalid JSON: ${message}`);
				result.valid = false;
				return result;
			}

			// Basic stats
			result.stats.totalKeys = this.countKeys(translations);

			// For English, no further validation
			if (locale === 'en') {
				return result;
			}

			// Compare with English keys
			const englishKeys = this.getAllKeys(this.englishTranslations);
			const localeKeys = this.getAllKeys(translations);

			// Missing keys
			const missingKeys = englishKeys.filter(key => !localeKeys.includes(key));
			result.stats.missingKeys = missingKeys.length;
			if (missingKeys.length > 0) {
				result.errors.push(`${missingKeys.length} missing keys: ${missingKeys.slice(0, 3).join(', ')}${missingKeys.length > 3 ? '...' : ''}`);
				result.valid = false;
			}

			// Extra keys
			const extraKeys = localeKeys.filter(key => !englishKeys.includes(key));
			result.stats.extraKeys = extraKeys.length;
			if (extraKeys.length > 0) {
				result.warnings.push(`${extraKeys.length} extra keys: ${extraKeys.slice(0, 3).join(', ')}${extraKeys.length > 3 ? '...' : ''}`);
			}

			// Empty values
			const emptyValues = this.findEmptyValues(translations);
			result.stats.emptyValues = emptyValues.length;
			if (emptyValues.length > 0) {
				result.errors.push(`${emptyValues.length} empty values: ${emptyValues.slice(0, 3).join(', ')}${emptyValues.length > 3 ? '...' : ''}`);
				result.valid = false;
			}

			// Check placeholders
			const placeholderPattern = /TODO|FIXME|\\[TRANSLE\\]|translation needed|TBD|TBA/i;
			const checkPlaceholders = (obj: Record<string, unknown>, path = ''): string[] => {
				const found: string[] = [];
				for (const [key, value] of Object.entries(obj)) {
					const currentPath = path !== '' ? `${path}.${key}` : key;
					if (typeof value === 'object' && value !== null) {
						found.push(...checkPlaceholders(value as Record<string, unknown>, currentPath));
					}
					else if (typeof value === 'string' && placeholderPattern.test(value)) {
						found.push(currentPath);
					}
				}
				return found;
			};

			const placeholders = checkPlaceholders(translations);
			if (placeholders.length > 0) {
				result.errors.push(`${placeholders.length} placeholders found: ${placeholders.slice(0, 3).join(', ')}${placeholders.length > 3 ? '...' : ''}`);
				result.valid = false;
			}
		}
catch (error) {
			result.errors.push(`Unexpected error: ${error}`);
			result.valid = false;
		}
		}

		return result;
	}

	/**
	 * Validates all translation files
	 */
	public validateAll(): ValidationResult[] {
		console.log(`${colors.blue}🔍 Validating translations...${colors.reset}\n`);

		const results: ValidationResult[] = [];

		for (const locale of this.allLocales) {
			const result = this.validateLocale(locale);
			results.push(result);
		}

		return results;
	}

	/**
	 * Prints a formatted validation report
	 */
	public printReport(results: ValidationResult[]): void {
		console.log(`${colors.bold}📊 TRANSLATION VALIDATION REPORT${colors.reset}\n`);

		// Global summary
		const totalLocales = results.length;
		const validLocales = results.filter(r => r.valid).length;
		const invalidLocales = totalLocales - validLocales;

		console.log(`${colors.bold}📈 Global Summary:${colors.reset}`);
		console.log(`   • Total locales: ${totalLocales}`);
		console.log(`   • ✅ Valid: ${colors.green}${validLocales}${colors.reset}`);
		console.log(`   • ❌ Invalid: ${invalidLocales > 0 ? colors.red : colors.green}${invalidLocales}${colors.reset}\n`);

		// Detailed stats
		console.log(`${colors.bold}📋 Details by Locale:${colors.reset}\n`);

		for (const result of results) {
			const status = result.valid ? `${colors.green}✅ VALID${colors.reset}` : `${colors.red}❌ INVALID${colors.reset}`;
			const flag = this.getFlag(result.locale);

			console.log(`${flag} ${colors.bold}${result.locale.toUpperCase()}${colors.reset} - ${status}`);
			console.log(`   📏 ${result.stats.totalKeys} keys, ${(result.stats.fileSize / 1024).toFixed(2)}KB`);

			if (result.errors.length > 0) {
				for (const error of result.errors) {
					console.log(`   ${colors.red}❌ ${error}${colors.reset}`);
				}
			}

			if (result.warnings.length > 0) {
				for (const warning of result.warnings) {
					console.log(`   ${colors.yellow}⚠️  ${warning}${colors.reset}`);
				}
			}

			console.log();
		}

		// Recommendations
		const invalidResults = results.filter(r => !r.valid);
		if (invalidResults.length > 0) {
			console.log(`${colors.yellow}💡 Recommendations:${colors.reset}`);
			console.log(`   • Fix errors in: ${invalidResults.map(r => r.locale).join(', ')}`);
			console.log(`   • Use 'npm run i18n:validate' to re-check`);
			console.log(`   • See locales/en.json as reference\n`);
		}

		// Compatibility matrix
		console.log(`${colors.bold}🌍 Compatibility Matrix:${colors.reset}`);
		const englishKeys = this.getAllKeys(this.englishTranslations);
		console.log(`   EN Reference: ${englishKeys.length} keys`);

		for (const result of results.filter(r => r.locale !== 'en')) {
			const coverage = ((result.stats.totalKeys - result.stats.missingKeys) / englishKeys.length * 100).toFixed(1);
			const coverageColor = Number.parseFloat(coverage) >= 100
				? colors.green
				: Number.parseFloat(coverage) >= 95 ? colors.yellow : colors.red;
			console.log(`   ${this.getFlag(result.locale)} ${result.locale}: ${coverageColor}${coverage}%${colors.reset} coverage`);
		}
	}

	/**
	 * Gets the flag emoji for a locale
	 */
	private getFlag(locale: string): string {
		const flags: Record<string, string> = {
			en: '🇺🇸',
			fr: '🇫🇷',
			es: '🇪🇸',
			de: '🇩🇪',
			ja: '🇯🇵',
			zh: '🇨🇳',
		};
		const flag = flags[locale];
		return flag !== undefined && flag !== null && flag !== '' ? flag : '🏁';
	}

	/**
	 * Main entry point
	 */
	public static main(): void {
		const validator = new TranslationValidator();
		const results = validator.validateAll();
		validator.printReport(results);

		// Exit code
		const hasErrors = results.some(r => !r.valid);
		process.exit(hasErrors ? 1 : 0);
	}
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
	TranslationValidator.main();
}

export { TranslationValidator };
