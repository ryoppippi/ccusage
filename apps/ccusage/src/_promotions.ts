import pc from 'picocolors';

/**
 * Promotion definition for time-limited usage multipliers
 */
type Promotion = {
	id: string;
	name: string;
	startDate: string;
	endDate: string;
	endTimezone: string;
	peakHours?: {
		startHour: number;
		endHour: number;
		timezone: string;
	};
	multiplier: string;
	statuslineLabel: string;
};

/**
 * Active promotions list — add new promotions here
 */
const ACTIVE_PROMOTIONS: Promotion[] = [
	{
		id: 'claude-march-2026-2x',
		name: 'Claude March 2026 2x Off-Peak',
		startDate: '2026-03-13',
		endDate: '2026-03-27',
		endTimezone: 'America/Los_Angeles',
		peakHours: { startHour: 5, endHour: 11, timezone: 'America/Los_Angeles' },
		multiplier: '2x',
		statuslineLabel: '\u26A12x',
	},
];

/**
 * Gets the current hour in a given timezone using Intl.DateTimeFormat
 */
function getHourInTimezone(date: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		hour12: false,
		timeZone: timezone,
	});
	return Number.parseInt(formatter.format(date), 10);
}

/**
 * Gets a YYYY-MM-DD date string in a given timezone
 */
function getDateStringInTimezone(date: Date, timezone: string): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		timeZone: timezone,
	});
	return formatter.format(date);
}

/**
 * Finds the first active promotion within the date range
 */
function getActivePromotion(now: Date = new Date()): Promotion | undefined {
	return ACTIVE_PROMOTIONS.find((promo) => {
		const dateStr = getDateStringInTimezone(now, promo.endTimezone);
		return dateStr >= promo.startDate && dateStr <= promo.endDate;
	});
}

/**
 * Checks if the current time is outside peak hours for a promotion
 * If no peakHours are defined, always returns true (always off-peak)
 */
function isOffPeakHours(promotion: Promotion, now: Date = new Date()): boolean {
	if (promotion.peakHours == null) {
		return true;
	}
	const hour = getHourInTimezone(now, promotion.peakHours.timezone);
	return hour < promotion.peakHours.startHour || hour >= promotion.peakHours.endHour;
}

/**
 * Gets the current minute in a given timezone using Intl.DateTimeFormat
 */
function getMinuteInTimezone(date: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		minute: 'numeric',
		timeZone: timezone,
	});
	return Number.parseInt(formatter.format(date), 10);
}

/**
 * Calculates minutes until off-peak hours start for a promotion
 * Returns null if already off-peak or no peak hours defined
 */
function getMinutesToOffPeak(promotion: Promotion, now: Date = new Date()): number | null {
	if (promotion.peakHours == null) {
		return null;
	}
	if (isOffPeakHours(promotion, now)) {
		return null;
	}
	const tz = promotion.peakHours.timezone;
	const currentHour = getHourInTimezone(now, tz);
	const currentMinute = getMinuteInTimezone(now, tz);
	const endHour = promotion.peakHours.endHour;
	return (endHour - currentHour) * 60 - currentMinute;
}

/**
 * Calculates days remaining until promotion ends (inclusive of end date)
 */
function getDaysUntilPromotionEnd(promotion: Promotion, now: Date = new Date()): number {
	const todayStr = getDateStringInTimezone(now, promotion.endTimezone);
	const todayMs = new Date(`${todayStr}T00:00:00`).getTime();
	const endMs = new Date(`${promotion.endDate}T00:00:00`).getTime();
	return Math.max(0, Math.ceil((endMs - todayMs) / (1000 * 60 * 60 * 24)));
}

/**
 * Formats minutes into compact time string (e.g., "2h15m", "45m")
 */
function formatCompactDuration(totalMinutes: number): string {
	const hours = Math.floor(totalMinutes / 60);
	const mins = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}h${mins}m`;
	}
	return `${mins}m`;
}

/**
 * Returns the formatted promotion segment for the statusline,
 * or an empty string if no promotion is active or it's peak hours
 */
function getPromotionStatuslineSegment(now: Date = new Date()): string {
	const promotion = getActivePromotion(now);
	if (promotion == null) {
		return '';
	}
	if (!isOffPeakHours(promotion, now)) {
		return '';
	}
	return pc.bold(pc.yellow(promotion.statuslineLabel));
}

/**
 * Returns an enhanced promotion segment that shows status during both peak and off-peak:
 * - Off-peak: "⚡2x" (bold yellow) with optional days remaining
 * - Peak: "⚡2x in 2h15m" (yellow, showing countdown to off-peak)
 * - No promotion: empty string
 */
function getEnhancedPromotionSegment(now: Date = new Date()): string {
	const promotion = getActivePromotion(now);
	if (promotion == null) {
		return '';
	}

	const daysLeft = getDaysUntilPromotionEnd(promotion, now);
	const daysStr = daysLeft > 0 ? pc.dim(` · ${daysLeft}d left`) : '';

	if (isOffPeakHours(promotion, now)) {
		return `${pc.bold(pc.yellow(promotion.statuslineLabel))}${daysStr}`;
	}

	// During peak hours — show countdown to off-peak
	const minutesToOffPeak = getMinutesToOffPeak(promotion, now);
	if (minutesToOffPeak != null && minutesToOffPeak > 0) {
		const countdown = formatCompactDuration(minutesToOffPeak);
		return `${pc.yellow(promotion.statuslineLabel)} ${pc.dim(`in ${countdown}`)}${daysStr}`;
	}

	return pc.bold(pc.yellow(promotion.statuslineLabel));
}

export {
	getActivePromotion,
	getDaysUntilPromotionEnd,
	getEnhancedPromotionSegment,
	getMinutesToOffPeak,
	getPromotionStatuslineSegment,
	isOffPeakHours,
};

if (import.meta.vitest != null) {
	describe('getActivePromotion', () => {
		it('should return promotion when date is within range', () => {
			const date = new Date('2026-03-15T12:00:00Z');
			const promo = getActivePromotion(date);
			expect(promo).toBeDefined();
			expect(promo?.id).toBe('claude-march-2026-2x');
		});

		it('should return undefined when date is before range', () => {
			const date = new Date('2026-03-12T12:00:00Z');
			const promo = getActivePromotion(date);
			expect(promo).toBeUndefined();
		});

		it('should return undefined when date is after range', () => {
			const date = new Date('2026-03-28T12:00:00Z');
			const promo = getActivePromotion(date);
			expect(promo).toBeUndefined();
		});

		it('should return promotion on start date', () => {
			// 2026-03-13 in PT
			const date = new Date('2026-03-13T20:00:00Z');
			const promo = getActivePromotion(date);
			expect(promo).toBeDefined();
		});

		it('should return promotion on end date', () => {
			// 2026-03-27 in PT
			const date = new Date('2026-03-27T12:00:00Z');
			const promo = getActivePromotion(date);
			expect(promo).toBeDefined();
		});
	});

	describe('isOffPeakHours', () => {
		const promo = ACTIVE_PROMOTIONS[0]!;

		it('should return true during off-peak hours (before 5 AM PT)', () => {
			// 3 AM PT = 11 AM UTC
			const date = new Date('2026-03-15T11:00:00Z');
			expect(isOffPeakHours(promo, date)).toBe(true);
		});

		it('should return false during peak hours (5 AM PT)', () => {
			// 5 AM PT = 1 PM UTC (during PDT)
			const date = new Date('2026-03-15T12:00:00Z');
			expect(isOffPeakHours(promo, date)).toBe(false);
		});

		it('should return false during peak hours (10 AM PT)', () => {
			// 10 AM PT = 6 PM UTC (during PDT)
			const date = new Date('2026-03-15T17:00:00Z');
			expect(isOffPeakHours(promo, date)).toBe(false);
		});

		it('should return true at 11 AM PT (end of peak)', () => {
			// 11 AM PT = 7 PM UTC (during PDT)
			const date = new Date('2026-03-15T18:00:00Z');
			expect(isOffPeakHours(promo, date)).toBe(true);
		});

		it('should return true during off-peak hours (evening PT)', () => {
			// 8 PM PT = 4 AM UTC+1 (during PDT)
			const date = new Date('2026-03-16T03:00:00Z');
			expect(isOffPeakHours(promo, date)).toBe(true);
		});

		it('should return true when peakHours is undefined', () => {
			const nopeakPromo: Promotion = {
				...promo,
				peakHours: undefined,
			};
			expect(isOffPeakHours(nopeakPromo)).toBe(true);
		});
	});

	describe('getPromotionStatuslineSegment', () => {
		it('should return formatted string during off-peak within promo dates', () => {
			// Off-peak: 8 PM PT on March 15
			const date = new Date('2026-03-16T03:00:00Z');
			const segment = getPromotionStatuslineSegment(date);
			expect(segment).not.toBe('');
			expect(segment).toContain('2x');
		});

		it('should return empty string during peak hours', () => {
			// Peak: 8 AM PT on March 15
			const date = new Date('2026-03-15T15:00:00Z');
			const segment = getPromotionStatuslineSegment(date);
			expect(segment).toBe('');
		});

		it('should return empty string outside promotion dates', () => {
			const date = new Date('2026-04-01T03:00:00Z');
			const segment = getPromotionStatuslineSegment(date);
			expect(segment).toBe('');
		});
	});

	describe('getMinutesToOffPeak', () => {
		const promo = ACTIVE_PROMOTIONS[0]!;

		it('should return null during off-peak hours', () => {
			// 8 PM PT (off-peak)
			const date = new Date('2026-03-16T03:00:00Z');
			expect(getMinutesToOffPeak(promo, date)).toBeNull();
		});

		it('should return minutes remaining during peak hours', () => {
			// 8 AM PT → 3 hours until 11 AM = 180 minutes
			const date = new Date('2026-03-15T15:00:00Z');
			const minutes = getMinutesToOffPeak(promo, date);
			expect(minutes).toBe(180);
		});

		it('should return minutes including partial hour', () => {
			// 10:30 AM PT → 30 minutes until 11 AM
			const date = new Date('2026-03-15T17:30:00Z');
			const minutes = getMinutesToOffPeak(promo, date);
			expect(minutes).toBe(30);
		});

		it('should return null when peakHours is undefined', () => {
			const nopeakPromo: Promotion = { ...promo, peakHours: undefined };
			expect(getMinutesToOffPeak(nopeakPromo)).toBeNull();
		});
	});

	describe('getDaysUntilPromotionEnd', () => {
		const promo = ACTIVE_PROMOTIONS[0]!;

		it('should return days remaining on start date', () => {
			// March 13 → March 27 = 14 days
			const date = new Date('2026-03-13T20:00:00Z');
			expect(getDaysUntilPromotionEnd(promo, date)).toBe(14);
		});

		it('should return 0 on end date', () => {
			// March 27 in PT
			const date = new Date('2026-03-27T20:00:00Z');
			expect(getDaysUntilPromotionEnd(promo, date)).toBe(0);
		});

		it('should return 0 after promotion ends', () => {
			const date = new Date('2026-03-28T12:00:00Z');
			expect(getDaysUntilPromotionEnd(promo, date)).toBe(0);
		});
	});

	describe('getEnhancedPromotionSegment', () => {
		it('should return label with days during off-peak', () => {
			// Off-peak: 8 PM PT on March 15 (12 days left)
			const date = new Date('2026-03-16T03:00:00Z');
			const segment = getEnhancedPromotionSegment(date);
			expect(segment).toContain('2x');
			expect(segment).toContain('12d left');
		});

		it('should return countdown during peak hours', () => {
			// Peak: 8 AM PT on March 15 → 3h to off-peak
			const date = new Date('2026-03-15T15:00:00Z');
			const segment = getEnhancedPromotionSegment(date);
			expect(segment).toContain('2x');
			expect(segment).toContain('in 3h0m');
		});

		it('should return empty string outside promotion dates', () => {
			const date = new Date('2026-04-01T03:00:00Z');
			const segment = getEnhancedPromotionSegment(date);
			expect(segment).toBe('');
		});
	});
}
