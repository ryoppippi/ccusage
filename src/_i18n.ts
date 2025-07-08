/**
 * Internationalization (i18n) module for ccusage CLI tool
 * Provides translation support for 6 languages: EN, FR, ES, DE, JA, ZH
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { logger } from './logger.ts';

/**
 * Supported locales
 */
export type Locale = 'en' | 'fr' | 'es' | 'de' | 'ja' | 'zh';

/**
 * Recursive translation data structure
 */
export type TranslationData = {
	[key: string]: string | TranslationData;
};

/**
 * Translation interpolation parameters
 */
export type InterpolationParams = (string | number)[];

/**
 * Main internationalization class implementing singleton pattern
 */
class I18n {
	private static instance: I18n;
	private currentLocale: Locale = 'en';
	private translations: Map<Locale, TranslationData> = new Map();
	private fallbackTranslations: TranslationData = {};

	private constructor() {
		// Private constructor for singleton pattern
	}

	/**
	 * Get the singleton instance of I18n
	 */
	public static getInstance(): I18n {
		if (I18n.instance === undefined) {
			I18n.instance = new I18n();
		}
		return I18n.instance;
	}

	/**
	 * Detect locale from environment variables and CLI arguments
	 * Priority: CLI args > LANG env var > LC_ALL env var > default 'en'
	 */
	public detectLocale(cliLocale?: string): Locale {
		// If CLI argument provided (not 'auto'), use it
		if (cliLocale !== undefined && cliLocale !== null && cliLocale !== '' && cliLocale !== 'auto' && this.isValidLocale(cliLocale)) {
			return cliLocale as Locale;
		}

		// Try environment variables
		const envLang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE;
		if (envLang !== undefined && envLang !== null && envLang !== '') {
			// Extract language code (e.g., 'fr_FR.UTF-8' -> 'fr')
			const splitResult = envLang.split(/[_.-]/);
			const langCode = splitResult.length > 0 && splitResult[0] !== undefined ? splitResult[0].toLowerCase() : undefined;
			if (langCode !== undefined && langCode !== null && langCode !== '' && this.isValidLocale(langCode)) {
				return langCode as Locale;
			}
		}

		// Default fallback
		return 'en';
	}

	/**
	 * Check if a string is a valid locale
	 */
	private isValidLocale(locale: string): boolean {
		return ['en', 'fr', 'es', 'de', 'ja', 'zh'].includes(locale);
	}

	/**
	 * Load translations for a specific locale with fallback to EN
	 */
	public loadTranslations(locale: Locale): void {
		try {
			// Load fallback (EN) translations first
			this.loadFallbackTranslations();

			// Load requested locale translations
			const translationPath = path.join(process.cwd(), 'locales', `${locale}.json`);

			if (existsSync(translationPath)) {
				const translationContent = readFileSync(translationPath, 'utf-8');
				const translations = JSON.parse(translationContent) as TranslationData;
				this.translations.set(locale, translations);
			}
			else if (locale !== 'en') {
				logger.warn(this.tp('messages.errors.translationFileNotFound', { locale }));
				// Force fallback to English by updating current locale
				this.currentLocale = 'en';
			}
		}
		catch (error) {
			logger.error(this.tp('messages.errors.errorLoadingTranslations', { locale }), error);
			// Continue with fallback translations and force locale to English
			if (locale !== 'en') {
				this.currentLocale = 'en';
			}
		}
	}

	/**
	 * Load fallback (EN) translations
	 */
	private loadFallbackTranslations(): void {
		try {
			const fallbackPath = path.join(process.cwd(), 'locales', 'en.json');
			if (existsSync(fallbackPath)) {
				const fallbackContent = readFileSync(fallbackPath, 'utf-8');
				this.fallbackTranslations = JSON.parse(fallbackContent) as TranslationData;
				this.translations.set('en', this.fallbackTranslations);
			}
		}
		catch (error) {
			logger.error(this.t('messages.errors.errorLoadingFallback'), error);
			// Set empty fallback to prevent crashes
			this.fallbackTranslations = {};
		}
	}

	/**
	 * Get translation by hierarchical key path
	 * @param key - Dot-separated key path (e.g., 'commands.descriptions.daily')
	 * @param locale - Target locale (optional, uses current locale)
	 * @returns Translation value or undefined if not found
	 */
	public getTranslation(key: string, locale?: Locale): string | undefined {
		const targetLocale = locale !== undefined && locale !== null ? locale : this.currentLocale;
		const translations = this.translations.get(targetLocale) !== undefined ? this.translations.get(targetLocale)! : this.fallbackTranslations;

		return this.getNestedValue(translations, key);
	}

	/**
	 * Navigate through nested object using dot notation
	 */
	private getNestedValue(obj: TranslationData, path: string): string | undefined {
		const keys = path.split('.');
		let current: string | TranslationData = obj;

		for (const key of keys) {
			if (typeof current === 'object' && current !== null && current !== undefined && key in current) {
				const nextValue: string | TranslationData = current[key] as string | TranslationData;
				if (nextValue !== undefined) {
					current = nextValue;
				}
				else {
					return undefined;
				}
			}
			else {
				return undefined;
			}
		}

		return typeof current === 'string' ? current : undefined;
	}

	/**
	 * Translate a key with interpolation support
	 * @param key - Translation key (dot notation)
	 * @param params - Parameters for interpolation {0}, {1}, etc.
	 * @returns Translated and interpolated string
	 */
	public t(key: string, ...params: InterpolationParams): string {
		// Try current locale first
		let translation = this.getTranslation(key, this.currentLocale);

		// Fallback to English if not found
		if ((translation === undefined || translation === null || translation === '') && this.currentLocale !== 'en') {
			translation = this.getTranslation(key, 'en');
		}

		// If still not found, return the key itself as fallback
		if (translation === undefined || translation === null || translation === '') {
			logger.warn(`Translation not found for key: ${key}`);
			return key;
		}

		// Apply interpolation
		return this.interpolate(translation, params);
	}

	/**
	 * Apply parameter interpolation to translation string
	 * @param template - Template string with {0}, {1}, etc. placeholders
	 * @param params - Parameters to interpolate
	 * @returns Interpolated string
	 */
	private interpolate(template: string, params: InterpolationParams): string {
		return template.replace(/\{(\d+)\}/g, (match, index) => {
			const paramIndex = Number.parseInt(String(index), 10);
			const param = params[paramIndex];
			return param !== undefined && param !== null ? param.toString() : match;
		});
	}

	/**
	 * Set the current locale and load its translations
	 * @param locale - Locale to set (will fallback to English if invalid)
	 */
	public setLocale(locale: Locale): void {
		if (!this.isValidLocale(locale)) {
			logger.warn(this.tp('messages.errors.invalidLocale', { locale }));
			this.currentLocale = 'en';
			this.loadTranslations('en');
			return;
		}

		this.currentLocale = locale;
		this.loadTranslations(locale);
	}

	/**
	 * Get the current locale
	 * @returns Current locale
	 */
	public getLocale(): Locale {
		return this.currentLocale;
	}

	/**
	 * Initialize i18n with locale detection and translation loading
	 * @param cliLocale - Locale from CLI argument (optional)
	 */
	public initialize(cliLocale?: string): void {
		const detectedLocale = this.detectLocale(cliLocale);
		this.setLocale(detectedLocale);
	}

	/**
	 * Get translation by hierarchical key path with parameter substitution
	 * @param key - Dot-separated key path (e.g., 'pricing.loadedModels')
	 * @param params - Object with parameters to substitute (e.g., { count: 42 })
	 * @param locale - Target locale (optional, uses current locale)
	 * @returns Translation value with parameters substituted
	 */
	public getTranslationWithParams(key: string, params: Record<string, string | number>, locale?: Locale): string {
		const template = this.getTranslation(key, locale);
		if (template === undefined || template === null || template === '') {
			return key; // Return key if translation not found
		}

		// Replace parameters in format {paramName}
		return template.replace(/\{(\w+)\}/g, (match, paramName: string) => {
			const value = params[paramName];
			return value !== undefined ? String(value) : match;
		});
	}

	/**
	 * Translate a key with fallback to original text and parameter substitution
	 * @param key - Translation key (hierarchical dot notation)
	 * @param params - Object with parameters to substitute
	 * @returns Translated text with parameters substituted or original key if not found
	 */
	public tp(key: string, params: Record<string, string | number> = {}): string {
		const translation = this.getTranslationWithParams(key, params);
		if (translation === key) {
			// Translation not found, log warning and return key
			logger.warn(`Translation not found for key: ${key}`);
		}
		return translation;
	}
}

// Export singleton instance
export const i18n = I18n.getInstance();
