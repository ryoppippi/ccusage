/**
 * @fileoverview Project name formatting and alias utilities
 *
 * Provides utilities for formatting raw project directory names into user-friendly
 * display names with support for custom aliases and improved path parsing.
 *
 * @module project-names
 */

/**
 * Extract meaningful project name from directory-style project paths
 * Uses improved heuristics to handle complex project structures
 *
 * @param projectName - Raw project name from directory path
 * @returns Cleaned and formatted project name
 *
 * @example
 * ```typescript
 * // Basic cleanup
 * parseProjectName('-Users-phaedrus-Development-ccusage')
 * // → 'ccusage'
 *
 * // Complex project with feature branch
 * parseProjectName('-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot')
 * // → 'configure-dependabot'
 *
 * // Handle unknown projects
 * parseProjectName('unknown')
 * // → 'Unknown Project'
 * ```
 */
function parseProjectName(projectName: string): string {
	if (projectName === 'unknown' || projectName === '') {
		return 'Unknown Project';
	}

	// Remove common directory prefixes
	let cleaned = projectName;

	// Handle Windows-style paths: C:\Users\... or \Users\...
	if (cleaned.match(/^[A-Z]:\\Users\\|^\\Users\\/) != null) {
		const segments = cleaned.split('\\');
		const userIndex = segments.findIndex(seg => seg === 'Users');
		if (userIndex !== -1 && userIndex + 3 < segments.length) {
			// Take everything after Users/username/Projects or similar
			cleaned = segments.slice(userIndex + 3).join('-');
		}
	}

	// Handle Unix-style paths: /Users/... or -Users-...
	if (cleaned.startsWith('-Users-') || cleaned.startsWith('/Users/')) {
		const separator = cleaned.startsWith('-Users-') ? '-' : '/';
		const segments = cleaned.split(separator).filter(s => s.length > 0);
		const userIndex = segments.findIndex(seg => seg === 'Users');

		if (userIndex !== -1 && userIndex + 3 < segments.length) {
			// Take everything after Users/username/Development or similar
			cleaned = segments.slice(userIndex + 3).join('-');
		}
	}

	// If no path cleanup occurred, use original name
	if (cleaned === projectName) {
		// Just basic cleanup for non-path names
		cleaned = projectName.replace(/^[/\\-]+|[/\\-]+$/g, '');
	}

	// Handle UUID-like patterns
	if (cleaned.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i) != null) {
		// Extract last two segments of UUID for brevity
		const parts = cleaned.split('-');
		if (parts.length >= 5) {
			// Take the last two segments, which may include file extension in the last segment
			cleaned = parts.slice(-2).join('-');
		}
	}

	// Improved project name extraction for complex names
	if (cleaned.includes('--')) {
		// Handle project--feature patterns like "adminifi-edugakko-api--feature-ticket-002"
		const parts = cleaned.split('--');
		if (parts.length >= 2 && parts[0] != null) {
			// Take the main project part before the first --
			cleaned = parts[0];
		}
	}

	// For compound project names, try to extract the most meaningful part
	if (cleaned.includes('-') && cleaned.length > 20) {
		const segments = cleaned.split('-');

		// Look for common meaningful patterns
		const meaningfulSegments = segments.filter(seg =>
			seg.length > 2
			&& seg.match(/^(?:dev|development|feat|feature|fix|bug|test|staging|prod|production|main|master|branch)$/i) == null,
		);

		// If we have compound project names like "adminifi-edugakko-api"
		// Try to find the last 2-3 meaningful segments
		if (meaningfulSegments.length >= 2) {
			// Take last 2-3 segments to get "edugakko-api" from "adminifi-edugakko-api"
			const lastSegments = meaningfulSegments.slice(-2);
			if (lastSegments.join('-').length >= 6) {
				cleaned = lastSegments.join('-');
			}
			else if (meaningfulSegments.length >= 3) {
				cleaned = meaningfulSegments.slice(-3).join('-');
			}
		}
	}

	// Final cleanup
	cleaned = cleaned.replace(/^[/\\-]+|[/\\-]+$/g, '');

	return cleaned !== '' ? cleaned : (projectName !== '' ? projectName : 'Unknown Project');
}

/**
 * Format project name for display with custom alias support
 *
 * @param projectName - Raw project name from directory path
 * @param aliases - Optional map of project names to their aliases
 * @returns User-friendly project name with alias support
 *
 * @example
 * ```typescript
 * // Without aliases
 * formatProjectName('-Users-phaedrus-Development-ccusage')
 * // → 'ccusage'
 *
 * // With alias
 * const aliases = new Map([['ccusage', 'Usage Tracker']]);
 * formatProjectName('-Users-phaedrus-Development-ccusage', aliases)
 * // → 'Usage Tracker'
 * ```
 */
export function formatProjectName(projectName: string, aliases?: Map<string, string>): string {
	// Check for custom alias first
	if (aliases != null && aliases.has(projectName)) {
		return aliases.get(projectName)!;
	}

	// Parse the project name using improved logic
	const parsed = parseProjectName(projectName);

	// Check if parsed name has an alias
	if (aliases != null && aliases.has(parsed)) {
		return aliases.get(parsed)!;
	}

	return parsed;
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('project name formatting', () => {
		describe('parseProjectName', () => {
			it('handles unknown project names', () => {
				expect(formatProjectName('unknown')).toBe('Unknown Project');
				expect(formatProjectName('')).toBe('Unknown Project');
			});

			it('extracts project names from Unix-style paths', () => {
				expect(formatProjectName('-Users-phaedrus-Development-ccusage')).toBe('ccusage');
				expect(formatProjectName('/Users/phaedrus/Development/ccusage')).toBe('ccusage');
			});

			it('handles complex project names with features', () => {
				const complexName = '-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot';
				const result = formatProjectName(complexName);
				// Current logic processes the name and extracts meaningful segments
				expect(result).toBe('configure-dependabot');
			});

			it('handles UUID-based project names', () => {
				const uuidName = 'a2cd99ed-a586-4fe4-8f59-b0026409ec09.jsonl';
				const result = formatProjectName(uuidName);
				expect(result).toBe('8f59-b0026409ec09.jsonl');
			});

			it('returns original name for simple names', () => {
				expect(formatProjectName('simple-project')).toBe('simple-project');
				expect(formatProjectName('project')).toBe('project');
			});
		});

		describe('custom aliases', () => {
			it('uses configured aliases', () => {
				const aliases = new Map([
					['ccusage', 'Usage Tracker'],
					['test', 'Test Project'],
				]);

				expect(formatProjectName('ccusage', aliases)).toBe('Usage Tracker');
				expect(formatProjectName('test', aliases)).toBe('Test Project');
				expect(formatProjectName('other', aliases)).toBe('other');
			});

			it('applies aliases to parsed project names', () => {
				const aliases = new Map([['ccusage', 'Usage Tracker']]);

				expect(formatProjectName('-Users-phaedrus-Development-ccusage', aliases)).toBe('Usage Tracker');
			});

			it('works without aliases', () => {
				expect(formatProjectName('test')).toBe('test');
				expect(formatProjectName('test', undefined)).toBe('test');
				expect(formatProjectName('test', new Map())).toBe('test');
			});
		});
	});
}
