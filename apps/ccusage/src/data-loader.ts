/**
 * @fileoverview Data loading utilities for Claude Code usage analysis
 *
 * This module provides functions for loading and parsing Claude Code usage data
 * from JSONL files stored in Claude data directories. It handles data aggregation
 * for daily, monthly, and session-based reporting.
 *
 * @module data-loader
 */

import type { LiteLLMModelPricing } from '@ccusage/internal/pricing';
import type { WeekDay } from './_consts.ts';
import type { LoadedUsageEntry, SessionBlock } from './_session-blocks.ts';
import type {
	ActivityDate,
	Bucket,
	CostMode,
	DailyDate,
	ISOTimestamp,
	MessageId,
	ModelName,
	MonthlyDate,
	ProjectPath,
	RequestId,
	SessionId,
	SortOrder,
	Version,
	WeeklyDate,
} from './_types.ts';
import { Buffer } from 'node:buffer';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readdir, readFile, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { toArray } from '@antfu/utils';
import { createResultSlots } from '@ccusage/internal/array';
import { compareStrings } from '@ccusage/internal/sort';
import { Result } from '@praha/byethrow';
import { createFixture } from 'fs-fixture';
import { isDirectorySync } from 'path-type';
import * as v from 'valibot';
import {
	CLAUDE_CONFIG_DIR_ENV,
	CLAUDE_PROJECTS_DIR_NAME,
	DEFAULT_CLAUDE_CODE_PATH,
	DEFAULT_CLAUDE_CONFIG_PATH,
	USER_HOME_DIR,
} from './_consts.ts';
import {
	createCachedDateFormatter,
	filterByDateRange,
	formatDate,
	getDateStringWeek,
	getDayNumber,
	sortByDate,
} from './_date-utils.ts';
import { CLAUDE_PROVIDER_PREFIXES, PricingFetcher } from './_pricing-fetcher.ts';
import { identifySessionBlocks } from './_session-blocks.ts';
import {
	createBucket,
	createISOTimestamp,
	createMessageId,
	createModelName,
	createRequestId,
	createSessionId,
	createVersion,
	isoTimestampSchema,
	messageIdSchema,
	modelNameSchema,
	requestIdSchema,
	sessionIdSchema,
	versionSchema,
} from './_types.ts';
import { unreachable } from './_utils.ts';
import { logger } from './logger.ts';

const USAGE_LINE_MARKER = '"usage":{';
const USAGE_LINE_MARKER_BUFFER = Buffer.from(USAGE_LINE_MARKER);
const CACHE_CREATION_INPUT_TOKENS_MARKER = '"cache_creation_input_tokens":';
const CACHE_READ_INPUT_TOKENS_MARKER = '"cache_read_input_tokens":';
const CONTENT_MARKER = '"content":';
const COST_USD_MARKER = '"costUSD":';
const INPUT_TOKENS_MARKER = '"input_tokens":';
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_BUFFERED_JSONL_BYTES = 128 * 1024 * 1024;
const JSONL_WORKER_THREAD_LIMIT = 9;
const MESSAGE_ID_MARKER = '"id":"';
const MODEL_MARKER = '"model":"';
const OUTPUT_TOKENS_MARKER = '"output_tokens":';
const REQUEST_ID_MARKER = '"requestId":"';
const SPEED_MARKER = '"speed":"';
const TIMESTAMP_MARKER = '"timestamp":"';
const VERSION_MARKER = '"version":"';
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;
function parseTwoDigits(value: string, offset: number): number {
	return (value.charCodeAt(offset) - 48) * 10 + value.charCodeAt(offset + 1) - 48;
}

function parseFourDigits(value: string, offset: number): number {
	return (
		(value.charCodeAt(offset) - 48) * 1000 +
		(value.charCodeAt(offset + 1) - 48) * 100 +
		(value.charCodeAt(offset + 2) - 48) * 10 +
		(value.charCodeAt(offset + 3) - 48)
	);
}

function hasAsciiDigits(value: string, start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) {
			return false;
		}
	}
	return true;
}

function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 1:
		case 3:
		case 5:
		case 7:
		case 8:
		case 10:
		case 12:
			return 31;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		case 2:
			return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
		default:
			return 0;
	}
}

function parseIsoTimestampMs(value: string): number {
	const length = value.length;
	if (
		(length !== 20 && length !== 24) ||
		value.charCodeAt(length - 1) !== 90 ||
		value.charCodeAt(4) !== 45 ||
		value.charCodeAt(7) !== 45 ||
		value.charCodeAt(10) !== 84 ||
		value.charCodeAt(13) !== 58 ||
		value.charCodeAt(16) !== 58 ||
		(length === 24 && value.charCodeAt(19) !== 46) ||
		!hasAsciiDigits(value, 0, 4) ||
		!hasAsciiDigits(value, 5, 7) ||
		!hasAsciiDigits(value, 8, 10) ||
		!hasAsciiDigits(value, 11, 13) ||
		!hasAsciiDigits(value, 14, 16) ||
		!hasAsciiDigits(value, 17, 19) ||
		(length === 24 && !hasAsciiDigits(value, 20, 23))
	) {
		return Number.NaN;
	}

	const year = parseFourDigits(value, 0);
	const month = parseTwoDigits(value, 5);
	const day = parseTwoDigits(value, 8);
	const hour = parseTwoDigits(value, 11);
	const minute = parseTwoDigits(value, 14);
	const second = parseTwoDigits(value, 17);
	const millisecond =
		length === 24
			? (value.charCodeAt(20) - 48) * 100 +
				(value.charCodeAt(21) - 48) * 10 +
				(value.charCodeAt(22) - 48)
			: 0;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		millisecond > 999
	) {
		return Number.NaN;
	}

	return Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
}

function dateFromIsoTimestamp(value: string): Date | null {
	const timestamp = parseIsoTimestampMs(value);
	return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function getJSONLFileReadConcurrency(fileCount: number, singleThread = false): number {
	if (singleThread) {
		return 1;
	}

	const configured = Number.parseInt(process.env.CCUSAGE_JSONL_READ_CONCURRENCY ?? '', 10);
	if (Number.isFinite(configured) && configured > 0) {
		return Math.max(1, Math.min(fileCount, configured));
	}

	return Math.max(1, Math.min(fileCount, os.availableParallelism()));
}

function getDefaultJSONLWorkerThreadCount(fileCount: number, preferMoreWorkers = false): number {
	const available = os.availableParallelism();
	// Daily/session workloads mostly fan out independent usage-row parsing, so they can use more
	// cores. Blocks return heavier per-file payloads and spend more time merging, where extra
	// workers can lose to startup and structured-clone overhead.
	const workerCount = Math.min(
		preferMoreWorkers ? Math.ceil(available * 0.75) : Math.ceil(available / 2),
		JSONL_WORKER_THREAD_LIMIT,
	);
	return Math.min(fileCount, Math.max(1, workerCount));
}

function getTimestampFromLine(line: string): Date | null {
	const timestamp = extractStringMarker(line, TIMESTAMP_MARKER);
	if (timestamp != null) {
		const date = dateFromIsoTimestamp(timestamp);
		if (date != null) {
			return date;
		}
	}

	if (!line.includes('"timestamp"')) {
		return null;
	}

	try {
		const json = JSON.parse(line) as Record<string, unknown>;
		if (typeof json.timestamp !== 'string') {
			return null;
		}
		const date = dateFromIsoTimestamp(json.timestamp) ?? new Date(json.timestamp);
		return Number.isNaN(date.getTime()) ? null : date;
	} catch {
		return null;
	}
}

/**
 * Get Claude data directories to search for usage data
 * When CLAUDE_CONFIG_DIR is set: uses only those paths
 * When not set: uses default paths (~/.config/claude and ~/.claude)
 * @returns Array of valid Claude data directory paths
 */
export function getClaudePaths(): string[] {
	const paths = [];
	const normalizedPaths = new Set<string>();

	// Check environment variable first (supports comma-separated paths)
	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	if (envPaths !== '') {
		const envPathList = envPaths
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p !== '');
		for (const envPath of envPathList) {
			const normalizedPath = path.resolve(envPath);
			if (isDirectorySync(normalizedPath)) {
				const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
				if (isDirectorySync(projectsPath)) {
					// Avoid duplicates using normalized paths
					if (!normalizedPaths.has(normalizedPath)) {
						normalizedPaths.add(normalizedPath);
						paths.push(normalizedPath);
					}
				}
			}
		}
		// If environment variable is set, return only those paths (or error if none valid)
		if (paths.length > 0) {
			return paths;
		}
		// If environment variable is set but no valid paths found, throw error
		throw new Error(
			`No valid Claude data directories found in CLAUDE_CONFIG_DIR. Please ensure the following exists:
- ${envPaths}/${CLAUDE_PROJECTS_DIR_NAME}`.trim(),
		);
	}

	// Only check default paths if no environment variable is set
	const defaultPaths = [
		DEFAULT_CLAUDE_CONFIG_PATH, // New default: XDG config directory
		path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH), // Old default: ~/.claude
	];

	for (const defaultPath of defaultPaths) {
		const normalizedPath = path.resolve(defaultPath);
		if (isDirectorySync(normalizedPath)) {
			const projectsPath = path.join(normalizedPath, CLAUDE_PROJECTS_DIR_NAME);
			if (isDirectorySync(projectsPath)) {
				// Avoid duplicates using normalized paths
				if (!normalizedPaths.has(normalizedPath)) {
					normalizedPaths.add(normalizedPath);
					paths.push(normalizedPath);
				}
			}
		}
	}

	if (paths.length === 0) {
		throw new Error(
			`No valid Claude data directories found. Please ensure at least one of the following exists:
- ${path.join(DEFAULT_CLAUDE_CONFIG_PATH, CLAUDE_PROJECTS_DIR_NAME)}
- ${path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH, CLAUDE_PROJECTS_DIR_NAME)}
- Or set ${CLAUDE_CONFIG_DIR_ENV} environment variable to valid directory path(s) containing a '${CLAUDE_PROJECTS_DIR_NAME}' subdirectory`.trim(),
		);
	}

	return paths;
}

/**
 * Extract project name from Claude JSONL file path
 * @param jsonlPath - Absolute path to JSONL file
 * @returns Project name extracted from path, or "unknown" if malformed
 */
export function extractProjectFromPath(jsonlPath: string): string {
	// Normalize path separators for cross-platform compatibility
	const normalizedPath = jsonlPath.replace(/[/\\]/g, path.sep);
	const segments = normalizedPath.split(path.sep);
	const projectsIndex = segments.findIndex((segment) => segment === CLAUDE_PROJECTS_DIR_NAME);

	if (projectsIndex === -1 || projectsIndex + 1 >= segments.length) {
		return 'unknown';
	}

	const projectName = segments[projectsIndex + 1];
	return projectName != null && projectName.trim() !== '' ? projectName : 'unknown';
}

/**
 * Valibot schema for validating Claude usage data from JSONL files
 */
export const usageDataSchema = v.object({
	cwd: v.optional(v.string()), // Claude Code version, optional for compatibility
	sessionId: v.optional(sessionIdSchema), // Session ID for deduplication
	timestamp: isoTimestampSchema,
	version: v.optional(versionSchema), // Claude Code version
	message: v.object({
		usage: v.object({
			input_tokens: v.number(),
			output_tokens: v.number(),
			cache_creation_input_tokens: v.optional(v.number()),
			cache_read_input_tokens: v.optional(v.number()),
			speed: v.optional(v.picklist(['standard', 'fast'])),
		}),
		model: v.optional(modelNameSchema), // Model is inside message object
		id: v.optional(messageIdSchema), // Message ID for deduplication
		content: v.optional(
			v.array(
				v.object({
					text: v.optional(v.string()),
				}),
			),
		),
	}),
	costUSD: v.optional(v.number()), // Made optional for new schema
	requestId: v.optional(requestIdSchema), // Request ID for deduplication
	isApiErrorMessage: v.optional(v.boolean()),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isOptionalNumber(value: unknown): value is number | undefined {
	return value === undefined || typeof value === 'number';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === 'boolean';
}

function sumUsageTokens(usage: UsageData['message']['usage']): number {
	return (
		usage.input_tokens +
		usage.output_tokens +
		(usage.cache_creation_input_tokens ?? 0) +
		(usage.cache_read_input_tokens ?? 0)
	);
}

function formatUsageModelName(
	model: UsageData['message']['model'],
	speed: UsageData['message']['usage']['speed'],
): string | undefined {
	return model == null ? undefined : speed === 'fast' ? `${model}-fast` : model;
}

function formatUsageModelNameOrUnknown(
	model: UsageData['message']['model'],
	speed: UsageData['message']['usage']['speed'],
): string {
	return formatUsageModelName(model, speed) ?? 'unknown';
}

function parseUsageDataFast(value: unknown): UsageData | null {
	if (!isRecord(value)) {
		return null;
	}
	if (
		!isOptionalString(value.cwd) ||
		!isOptionalNonEmptyString(value.sessionId) ||
		!isOptionalNonEmptyString(value.requestId) ||
		!isOptionalNumber(value.costUSD) ||
		!isOptionalBoolean(value.isApiErrorMessage)
	) {
		return null;
	}
	if (
		value.version !== undefined &&
		(typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version))
	) {
		return null;
	}
	if (typeof value.timestamp !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value.timestamp)) {
		return null;
	}
	if (!isRecord(value.message)) {
		return null;
	}
	if (
		!isOptionalNonEmptyString(value.message.model) ||
		!isOptionalNonEmptyString(value.message.id)
	) {
		return null;
	}
	if (value.message.content !== undefined) {
		if (!Array.isArray(value.message.content)) {
			return null;
		}
		for (const part of value.message.content) {
			if (!isRecord(part) || !isOptionalString(part.text)) {
				return null;
			}
		}
	}
	if (!isRecord(value.message.usage)) {
		return null;
	}
	const { usage } = value.message;
	if (
		typeof usage.input_tokens !== 'number' ||
		typeof usage.output_tokens !== 'number' ||
		!isOptionalNumber(usage.cache_creation_input_tokens) ||
		!isOptionalNumber(usage.cache_read_input_tokens) ||
		(usage.speed !== undefined && usage.speed !== 'standard' && usage.speed !== 'fast')
	) {
		return null;
	}

	return value as UsageData;
}

function extractStringMarker(line: string, marker: string, fromIndex = 0): string | undefined {
	const start = line.indexOf(marker, fromIndex);
	if (start === -1) {
		return undefined;
	}
	const valueStart = start + marker.length;
	const valueEnd = line.indexOf('"', valueStart);
	return valueEnd === -1 ? undefined : line.slice(valueStart, valueEnd);
}

/**
 * Parse the numeric JSON value after a known field marker without allocating a substring.
 *
 * `costUSD` is absent on most local Claude rows, but when present it sits on the usage hot path.
 * The manual parser keeps that path compatible with JSON number forms, including signs, decimals,
 * and exponents, while avoiding `Number(line.slice(...))` allocation for every matched row. A local
 * mitata check measured this shape about 1.6x faster than slicing before `Number()`.
 */
function extractJsonNumberMarker(line: string, marker: string, fromIndex = 0): number | undefined {
	const start = line.indexOf(marker, fromIndex);
	if (start === -1) {
		return undefined;
	}

	let valueIndex = start + marker.length;
	let sign = 1;
	const signCode = line.charCodeAt(valueIndex);
	if (signCode === 45) {
		sign = -1;
		valueIndex++;
	} else if (signCode === 43) {
		valueIndex++;
	}

	let value = 0;
	let digitCount = 0;
	while (valueIndex < line.length) {
		const digit = line.charCodeAt(valueIndex) - 48;
		if (digit < 0 || digit > 9) {
			break;
		}
		value = value * 10 + digit;
		valueIndex++;
		digitCount++;
	}

	if (line.charCodeAt(valueIndex) === 46) {
		valueIndex++;
		let scale = 0.1;
		while (valueIndex < line.length) {
			const digit = line.charCodeAt(valueIndex) - 48;
			if (digit < 0 || digit > 9) {
				break;
			}
			value += digit * scale;
			scale *= 0.1;
			valueIndex++;
			digitCount++;
		}
	}

	if (digitCount === 0) {
		return undefined;
	}

	const exponentMarker = line.charCodeAt(valueIndex);
	if (exponentMarker === 69 || exponentMarker === 101) {
		valueIndex++;
		let exponentSign = 1;
		const exponentSignCode = line.charCodeAt(valueIndex);
		if (exponentSignCode === 45) {
			exponentSign = -1;
			valueIndex++;
		} else if (exponentSignCode === 43) {
			valueIndex++;
		}

		let exponent = 0;
		let exponentDigitCount = 0;
		while (valueIndex < line.length) {
			const digit = line.charCodeAt(valueIndex) - 48;
			if (digit < 0 || digit > 9) {
				break;
			}
			exponent = exponent * 10 + digit;
			valueIndex++;
			exponentDigitCount++;
		}
		if (exponentDigitCount === 0) {
			return undefined;
		}
		value *= 10 ** (exponentSign * exponent);
	}

	value *= sign;
	return Number.isFinite(value) ? value : undefined;
}

/**
 * Parse token counters after a known field marker without slicing.
 *
 * Token fields are required for every fast-path usage row, so this avoids a small allocation in the
 * tightest parser loop. It intentionally accepts unsigned integer JSON values only; anything else
 * falls back by returning `undefined`, matching the surrounding fast parser's conservative contract.
 */
function extractUnsignedIntegerMarker(
	line: string,
	marker: string,
	fromIndex = 0,
): number | undefined {
	const start = line.indexOf(marker, fromIndex);
	if (start === -1) {
		return undefined;
	}

	let valueIndex = start + marker.length;
	let value = 0;
	let hasDigit = false;
	while (valueIndex < line.length) {
		const digit = line.charCodeAt(valueIndex) - 48;
		if (digit < 0 || digit > 9) {
			break;
		}
		value = value * 10 + digit;
		valueIndex++;
		hasDigit = true;
	}

	return hasDigit ? value : undefined;
}

/**
 * Parse the common Claude assistant usage row without building a full JSON object.
 *
 * The hot path is dominated by JSONL rows with stable field names and numeric token counters.
 * Extracting only those fields keeps the common case cheap, while returning null lets the caller
 * fall back to JSON.parse for uncommon shapes such as null-bearing rows and API error messages.
 */
function parseUsageDataLineFast(
	line: string,
	allowContent = false,
	usageMarkerIndex?: number,
): UsageData | null {
	const messageStart = line.indexOf('"message":{');
	const usageStart =
		usageMarkerIndex != null && usageMarkerIndex >= messageStart
			? usageMarkerIndex
			: line.indexOf(USAGE_LINE_MARKER, messageStart);
	if (messageStart === -1 || usageStart === -1) {
		return null;
	}

	// The fast path only accepts Claude assistant rows. Anchor the content check inside the
	// message object so unrelated earlier JSON fields do not force a full-line marker scan.
	const contentIndex = line.indexOf(CONTENT_MARKER, messageStart);
	if (
		(contentIndex !== -1 &&
			(!allowContent || line.charCodeAt(contentIndex + CONTENT_MARKER.length) !== 91)) ||
		line.includes('"isApiErrorMessage":true') ||
		hasUnsupportedNullField(line)
	) {
		return null;
	}

	const timestamp = extractStringMarker(line, TIMESTAMP_MARKER);
	if (timestamp == null || !ISO_TIMESTAMP_PATTERN.test(timestamp)) {
		return null;
	}

	const roleStart = line.indexOf('"role":"assistant"', messageStart);
	if (roleStart === -1 || roleStart > usageStart) {
		return null;
	}

	const inputTokens = extractUnsignedIntegerMarker(line, INPUT_TOKENS_MARKER, usageStart);
	const outputTokens = extractUnsignedIntegerMarker(line, OUTPUT_TOKENS_MARKER, usageStart);
	if (inputTokens == null || outputTokens == null) {
		return null;
	}

	const speed = extractStringMarker(line, SPEED_MARKER, usageStart);
	if (speed != null && speed !== 'standard' && speed !== 'fast') {
		return null;
	}

	const version = extractStringMarker(line, VERSION_MARKER, usageStart);
	if (version != null && !VERSION_PATTERN.test(version)) {
		return null;
	}
	const model = extractStringMarker(line, MODEL_MARKER, messageStart);
	const messageId = extractStringMarker(line, MESSAGE_ID_MARKER, messageStart);
	const requestId = extractStringMarker(line, REQUEST_ID_MARKER, usageStart);
	if (model === '' || messageId === '' || requestId === '') {
		return null;
	}

	return {
		timestamp: timestamp as UsageData['timestamp'],
		message: {
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_creation_input_tokens: extractUnsignedIntegerMarker(
					line,
					CACHE_CREATION_INPUT_TOKENS_MARKER,
					usageStart,
				),
				cache_read_input_tokens: extractUnsignedIntegerMarker(
					line,
					CACHE_READ_INPUT_TOKENS_MARKER,
					usageStart,
				),
				speed,
			},
			model: model as ModelName | undefined,
			id: messageId as UsageData['message']['id'],
		},
		costUSD: extractJsonNumberMarker(line, COST_USD_MARKER, usageStart),
		requestId: requestId as UsageData['requestId'],
		version: version as Version | undefined,
	};
}

/**
 * Detect nulls only for fields that would change the fast parser's semantics.
 *
 * A broad regexp is easy to read but expensive across large logs. Scanning `:null` occurrences keeps
 * unrelated nullable JSON fields on the fast path and sends only schema-sensitive nulls to the full
 * parser.
 */
function hasUnsupportedNullField(line: string): boolean {
	let nullIndex = line.indexOf(':null');
	while (nullIndex !== -1) {
		let fieldEnd = nullIndex - 1;
		if (line.charCodeAt(fieldEnd) !== 34) {
			while (fieldEnd >= 0 && line.charCodeAt(fieldEnd) !== 34) {
				fieldEnd--;
			}
		}
		if (fieldEnd !== -1) {
			let fieldStart = fieldEnd - 1;
			while (fieldStart >= 0 && line.charCodeAt(fieldStart) !== 34) {
				fieldStart--;
			}
			if (fieldStart !== -1 && isUnsupportedNullableField(line, fieldStart + 1, fieldEnd)) {
				return true;
			}
		}
		nullIndex = line.indexOf(':null', nullIndex + 5);
	}
	return false;
}

function isFieldAt(line: string, start: number, end: number, field: string): boolean {
	return end - start === field.length && line.startsWith(field, start);
}

function isUnsupportedNullableField(line: string, start: number, end: number): boolean {
	switch (end - start) {
		case 2:
			return isFieldAt(line, start, end, 'id');
		case 3:
			return isFieldAt(line, start, end, 'cwd');
		case 5:
			return isFieldAt(line, start, end, 'model') || isFieldAt(line, start, end, 'speed');
		case 7:
			return isFieldAt(line, start, end, 'costUSD') || isFieldAt(line, start, end, 'version');
		case 9:
			return isFieldAt(line, start, end, 'sessionId') || isFieldAt(line, start, end, 'requestId');
		case 17:
			return isFieldAt(line, start, end, 'isApiErrorMessage');
		case 23:
			return isFieldAt(line, start, end, 'cache_read_input_tokens');
		case 27:
			return isFieldAt(line, start, end, 'cache_creation_input_tokens');
		default:
			return false;
	}
}

function parseUsageDataLine(
	line: string,
	options?: { allowContentFast?: boolean; usageMarkerIndex?: number },
): UsageData | null {
	const fastData = parseUsageDataLineFast(
		line,
		options?.allowContentFast !== false,
		options?.usageMarkerIndex,
	);
	if (fastData != null) {
		return fastData;
	}

	const parsed = JSON.parse(line) as unknown;
	return parseUsageDataFast(parsed);
}

/**
 * Valibot schema for transcript usage data from Claude messages
 */
export const transcriptUsageSchema = v.object({
	input_tokens: v.optional(v.number()),
	cache_creation_input_tokens: v.optional(v.number()),
	cache_read_input_tokens: v.optional(v.number()),
	output_tokens: v.optional(v.number()),
});

/**
 * Valibot schema for transcript message data
 */
export const transcriptMessageSchema = v.object({
	type: v.optional(v.string()),
	message: v.optional(
		v.object({
			usage: v.optional(transcriptUsageSchema),
		}),
	),
});

/**
 * Type definition for Claude usage data entries from JSONL files
 */
export type UsageData = {
	cwd?: string;
	sessionId?: SessionId;
	timestamp: ISOTimestamp;
	version?: Version;
	message: {
		usage: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
			speed?: 'standard' | 'fast';
		};
		model?: ModelName;
		id?: MessageId;
		content?: Array<{
			text?: string;
		}>;
	};
	costUSD?: number;
	requestId?: RequestId;
	isApiErrorMessage?: boolean;
};

/**
 * Type definition for model-specific usage breakdown
 */
export type ModelBreakdown = {
	modelName: ModelName;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

/**
 * Type definition for daily usage aggregation
 */
export type DailyUsage = {
	date: DailyDate;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
};

/**
 * Type definition for session-based usage aggregation
 */
export type SessionUsage = {
	sessionId: SessionId;
	projectPath: ProjectPath;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	lastActivity: ActivityDate;
	versions: Version[];
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
};

/**
 * Type definition for monthly usage aggregation
 */
export type MonthlyUsage = {
	month: MonthlyDate;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
};

/**
 * Type definition for weekly usage aggregation
 */
export type WeeklyUsage = {
	week: WeeklyDate;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
};

/**
 * Type definition for bucket usage aggregation
 */
export type BucketUsage = {
	bucket: Bucket;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
	project?: string;
};

/**
 * Internal type for aggregating token statistics and costs
 */
type TokenStats = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	cost: number;
};

type UsageSummary = TokenStats & {
	totalCost: number;
	modelsUsed: ModelName[];
	modelBreakdowns: ModelBreakdown[];
};

type TokenStatsIndex = Record<string, TokenStats | undefined>;
type ModelSeenIndex = Record<string, true | undefined>;

type UsageSummaryAccumulator = {
	totals: TokenStats & { totalCost: number };
	modelAggregates: TokenStatsIndex;
	modelSeen: ModelSeenIndex;
	modelsUsed: string[];
};

type BunFileLike = {
	size: number;
	bytes: () => Promise<Uint8Array>;
	text: () => Promise<string>;
};

type BunRuntimeLike = {
	file: (path: string) => BunFileLike;
};

function getDisplayModelName(data: UsageData): string | undefined {
	return formatUsageModelName(data.message.model, data.message.usage.speed);
}

function createEmptyTokenStats(): TokenStats {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		cost: 0,
	};
}

/**
 * Create a null-prototype model aggregate lookup for summary hot paths.
 *
 * Model names are plain strings and summary aggregation only needs exact-key lookup. This mirrors
 * the dedupe-index optimization while keeping arbitrary model names safe from inherited keys.
 */
function createTokenStatsIndex(): TokenStatsIndex {
	return Object.create(null) as TokenStatsIndex;
}

/**
 * Track model names without allocating a Set for every daily/session/bucket group.
 *
 * Reports need insertion-order `modelsUsed` output plus O(1) membership checks. A null-prototype
 * object stores membership and a side array preserves the same first-seen order that Set had.
 */
function addModelUsed(accumulator: UsageSummaryAccumulator, modelName: string): void {
	if (accumulator.modelSeen[modelName] != null) {
		return;
	}
	accumulator.modelSeen[modelName] = true;
	accumulator.modelsUsed.push(modelName);
}

function addUsageToTokenStats(
	stats: TokenStats,
	usage: UsageData['message']['usage'],
	cost: number,
): void {
	stats.inputTokens += usage.input_tokens ?? 0;
	stats.outputTokens += usage.output_tokens ?? 0;
	stats.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
	stats.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
	stats.cost += cost;
}

function createUsageSummaryAccumulator(): UsageSummaryAccumulator {
	return {
		totals: {
			...createEmptyTokenStats(),
			totalCost: 0,
		},
		modelAggregates: createTokenStatsIndex(),
		modelSeen: Object.create(null) as ModelSeenIndex,
		modelsUsed: [],
	};
}

function addUsageToSummaryAccumulator(
	accumulator: UsageSummaryAccumulator,
	model: string | undefined,
	usage: UsageData['message']['usage'],
	cost: number,
): void {
	const modelName = model ?? 'unknown';
	addUsageToTokenStats(accumulator.totals, usage, cost);
	accumulator.totals.totalCost += cost;

	if (modelName === '<synthetic>') {
		return;
	}

	if (model != null) {
		addModelUsed(accumulator, modelName);
	}

	let existing = accumulator.modelAggregates[modelName];
	if (existing == null) {
		existing = createEmptyTokenStats();
		accumulator.modelAggregates[modelName] = existing;
	}
	addUsageToTokenStats(existing, usage, cost);
}

function addTokenFieldsToSummaryAccumulator(
	accumulator: UsageSummaryAccumulator,
	model: string | undefined,
	tokens: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
	},
	cost: number,
): void {
	const modelName = model ?? 'unknown';
	accumulator.totals.inputTokens += tokens.inputTokens;
	accumulator.totals.outputTokens += tokens.outputTokens;
	accumulator.totals.cacheCreationTokens += tokens.cacheCreationTokens;
	accumulator.totals.cacheReadTokens += tokens.cacheReadTokens;
	accumulator.totals.cost += cost;
	accumulator.totals.totalCost += cost;

	if (modelName === '<synthetic>') {
		return;
	}

	if (model != null) {
		addModelUsed(accumulator, modelName);
	}

	let existing = accumulator.modelAggregates[modelName];
	if (existing == null) {
		existing = createEmptyTokenStats();
		accumulator.modelAggregates[modelName] = existing;
	}
	existing.inputTokens += tokens.inputTokens;
	existing.outputTokens += tokens.outputTokens;
	existing.cacheCreationTokens += tokens.cacheCreationTokens;
	existing.cacheReadTokens += tokens.cacheReadTokens;
	existing.cost += cost;
}

function finalizeUsageSummary(accumulator: UsageSummaryAccumulator): UsageSummary {
	return {
		...accumulator.totals,
		modelsUsed: accumulator.modelsUsed as ModelName[],
		modelBreakdowns: createModelBreakdowns(accumulator.modelAggregates),
	};
}

function summarizeUsageEntries<T>(
	entries: T[],
	getModel: (entry: T) => string | undefined,
	getUsage: (entry: T) => UsageData['message']['usage'],
	getCost: (entry: T) => number,
): UsageSummary {
	const accumulator = createUsageSummaryAccumulator();

	for (const entry of entries) {
		addUsageToSummaryAccumulator(accumulator, getModel(entry), getUsage(entry), getCost(entry));
	}

	return finalizeUsageSummary(accumulator);
}

/**
 * Converts model aggregates to sorted model breakdowns
 */
function createModelBreakdowns(modelAggregates: TokenStatsIndex): ModelBreakdown[] {
	const modelNames = Object.keys(modelAggregates);
	const breakdowns: ModelBreakdown[] = [];
	for (let index = 0; index < modelNames.length; index++) {
		const modelName = modelNames[index]!;
		breakdowns.push({
			modelName: modelName as ModelName,
			...modelAggregates[modelName]!,
		});
	}
	return breakdowns.sort((a, b) => b.cost - a.cost); // Sort by cost descending
}

/**
 * Filters items by project name
 */
function filterByProject<T>(
	items: T[],
	getProject: (item: T) => string | undefined,
	projectFilter?: string,
): T[] {
	if (projectFilter == null) {
		return items;
	}

	return items.filter((item) => {
		const projectName = getProject(item);
		return projectName === projectFilter;
	});
}

async function mapWithConcurrency<T, U>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
	const results = createResultSlots<U>(items.length);
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(concurrency, items.length));

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			// Each async runner claims the next index from the shared counter until work is exhausted.
			while (true) {
				const index = nextIndex++;
				if (index >= items.length) {
					return;
				}
				results[index] = await mapper(items[index]!, index);
			}
		}),
	);

	return results;
}

function parseCompactDate(value: string | undefined): Date | null {
	if (value == null || !/^\d{8}$/.test(value)) {
		return null;
	}

	const year = Number.parseInt(value.slice(0, 4), 10);
	const month = Number.parseInt(value.slice(4, 6), 10);
	const day = Number.parseInt(value.slice(6, 8), 10);
	const date = new Date(Date.UTC(year, month - 1, day));

	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day
	) {
		return null;
	}

	return date;
}

async function filterFilesByMtime<T>(
	items: T[],
	getFilePath: (item: T) => string,
	since?: string,
	minUpdateTime?: Date,
): Promise<T[]> {
	const sinceDate = parseCompactDate(since);
	const thresholdMsList: number[] = [];

	if (sinceDate != null) {
		sinceDate.setUTCDate(sinceDate.getUTCDate() - 1);
		thresholdMsList.push(sinceDate.getTime());
	}
	if (minUpdateTime != null && !Number.isNaN(minUpdateTime.getTime())) {
		thresholdMsList.push(minUpdateTime.getTime());
	}
	if (thresholdMsList.length === 0) {
		return items;
	}

	const thresholdMs = Math.max(...thresholdMsList);
	const keepFlags = await Promise.all(
		items.map(async (item) => {
			try {
				const stats = await stat(getFilePath(item));
				return stats.mtimeMs >= thresholdMs;
			} catch {
				return true;
			}
		}),
	);

	return items.filter((_, index) => keepFlags[index] === true);
}

/**
 * Create a unique identifier for deduplication using message ID and request ID
 */
export function createUniqueHash(data: UsageData): string | null {
	const messageId = data.message.id;
	const requestId = data.requestId;

	if (messageId == null || requestId == null) {
		return null;
	}

	// Create a hash using simple concatenation
	return `${messageId}:${requestId}`;
}

function hasNonWhitespace(line: string): boolean {
	for (let index = 0; index < line.length; index++) {
		if (line.charCodeAt(index) > 32) {
			return true;
		}
	}
	return false;
}

function getBunRuntime(): BunRuntimeLike | null {
	const runtime = (globalThis as { Bun?: Partial<BunRuntimeLike> }).Bun;
	return typeof runtime?.file === 'function' ? (runtime as BunRuntimeLike) : null;
}

async function processBufferedJSONLContent(
	content: string,
	processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
	let lineStart = 0;
	let lineNumber = 0;
	while (lineStart < content.length) {
		let lineEnd = content.indexOf('\n', lineStart);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		lineNumber++;
		let line = content.slice(lineStart, lineEnd);
		if (line.endsWith('\r')) {
			line = line.slice(0, -1);
		}
		if (hasNonWhitespace(line)) {
			const result = processLine(line, lineNumber);
			if (result != null) {
				await result;
			}
		}

		lineStart = lineEnd + 1;
	}
}

async function processBufferedJSONLUsageContent(
	content: string,
	processLine: (line: string, usageMarkerIndex: number) => void,
): Promise<void> {
	let lineStart = 0;
	let markerIndex = content.indexOf(USAGE_LINE_MARKER, lineStart);
	while (markerIndex !== -1) {
		// The marker search skips non-usage lines, so lineStart can lag behind markerIndex.
		// Advance it monotonically instead of reverse-scanning with lastIndexOf for every usage row.
		while (true) {
			const nextLineEnd = content.indexOf('\n', lineStart);
			if (nextLineEnd === -1 || nextLineEnd >= markerIndex) {
				break;
			}
			lineStart = nextLineEnd + 1;
		}
		let lineEnd = content.indexOf('\n', markerIndex);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		let line = content.slice(lineStart, lineEnd);
		if (line.endsWith('\r')) {
			line = line.slice(0, -1);
		}
		// The scanner already paid for the usage marker search; pass the line-relative offset so
		// the fast parser does not run the same indexOf again for every usage row.
		processLine(line, markerIndex - lineStart);

		lineStart = lineEnd + 1;
		markerIndex = content.indexOf(USAGE_LINE_MARKER, lineStart);
	}
}

/**
 * Scan buffered JSONL as bytes and decode only lines that contain a usage marker.
 *
 * Real Claude logs contain many non-usage rows. Keeping the file as bytes lets Bun search for the
 * marker without converting the whole file to UTF-16, then `toString()` is paid only for candidate
 * usage lines that the fast parser or JSON fallback can consume.
 */
async function processBufferedJSONLUsageBytes(
	bytes: Uint8Array,
	processLine: (line: string, usageMarkerIndex: number) => void,
): Promise<void> {
	const content = Buffer.isBuffer(bytes)
		? bytes
		: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let lineStart = 0;
	let markerIndex = content.indexOf(USAGE_LINE_MARKER_BUFFER, lineStart);
	while (markerIndex !== -1) {
		// Advance to the start of the marker's line without calling lastIndexOf for every usage row.
		// This loop is monotonic: each newline is considered at most once across the whole buffer.
		while (true) {
			const nextLineEnd = content.indexOf(10, lineStart);
			if (nextLineEnd === -1 || nextLineEnd >= markerIndex) {
				break;
			}
			lineStart = nextLineEnd + 1;
		}
		let lineEnd = content.indexOf(10, markerIndex);
		if (lineEnd === -1) {
			lineEnd = content.length;
		}

		const decodeEnd = lineEnd > lineStart && content[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
		// Usage aggregation reads ASCII metadata and token fields only; content text is never surfaced.
		// Latin-1 avoids UTF-8 decoding cost for large assistant content while preserving JSON markers.
		// The scanner already paid for the usage marker search; pass the line-relative offset so
		// the fast parser does not run the same indexOf again for every usage row.
		processLine(content.toString('latin1', lineStart, decodeEnd), markerIndex - lineStart);

		lineStart = lineEnd + 1;
		markerIndex = content.indexOf(USAGE_LINE_MARKER_BUFFER, lineStart);
	}
}

async function readBufferedJSONLBytes(filePath: string): Promise<Uint8Array | null> {
	const bun = getBunRuntime();
	if (bun != null) {
		const file = bun.file(filePath);
		return file.size <= MAX_BUFFERED_JSONL_BYTES ? file.bytes() : null;
	}

	// The usage-row scanner only decodes candidate lines. Keeping Node on bytes here avoids
	// converting the whole JSONL file to a UTF-16 string before most non-usage rows are skipped.
	const file = await open(filePath, 'r');
	try {
		const stats = await file.stat();
		if (stats.size <= MAX_BUFFERED_JSONL_BYTES) {
			return await file.readFile();
		}
		return null;
	} finally {
		await file.close();
	}
}

async function readBufferedJSONLContent(filePath: string): Promise<string | null> {
	const bun = getBunRuntime();
	if (bun != null) {
		const file = bun.file(filePath);
		if (file.size <= MAX_BUFFERED_JSONL_BYTES) {
			return file.text();
		}
	}

	const file = await open(filePath, 'r');
	try {
		const stats = await file.stat();
		if (stats.size <= MAX_BUFFERED_JSONL_BYTES) {
			return (await file.readFile()).toString('utf8');
		}
		return null;
	} finally {
		await file.close();
	}
}

/**
 * Process a JSONL file line by line using streams to avoid memory issues with large files
 * @param filePath - Path to the JSONL file
 * @param processLine - Callback function to process each line
 */
async function processJSONLFileByLine(
	filePath: string,
	processLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
	const content = await readBufferedJSONLContent(filePath);
	if (content != null) {
		await processBufferedJSONLContent(content, processLine);
		return;
	}

	const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	let lineNumber = 0;
	for await (const line of rl) {
		lineNumber++;
		if (!hasNonWhitespace(line)) {
			continue;
		}
		const result = processLine(line, lineNumber);
		if (result != null) {
			await result;
		}
	}
}

async function processJSONLUsageFileByLine(
	filePath: string,
	processLine: (line: string, usageMarkerIndex: number) => void,
): Promise<void> {
	const bytes = await readBufferedJSONLBytes(filePath);
	if (bytes != null) {
		await processBufferedJSONLUsageBytes(bytes, processLine);
		return;
	}

	const content = await readBufferedJSONLContent(filePath);
	if (content != null) {
		await processBufferedJSONLUsageContent(content, processLine);
		return;
	}

	const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
	const rl = createInterface({
		input: fileStream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});

	for await (const line of rl) {
		const usageMarkerIndex = line.indexOf(USAGE_LINE_MARKER);
		if (usageMarkerIndex === -1) {
			continue;
		}
		processLine(line, usageMarkerIndex);
	}
}

/**
 * Extract the earliest timestamp from a JSONL file
 * Scans through the file until it finds a valid timestamp
 * Uses streaming to handle large files without loading entire content into memory
 */
export async function getEarliestTimestamp(filePath: string): Promise<Date | null> {
	try {
		let earliestDate: Date | null = null;

		await processJSONLFileByLine(filePath, (line) => {
			const date = getTimestampFromLine(line);
			if (date != null && (earliestDate == null || date < earliestDate)) {
				earliestDate = date;
			}
		});

		return earliestDate;
	} catch (error) {
		// Log file access errors for diagnostics, but continue processing
		// This ensures files without timestamps or with access issues are sorted to the end
		logger.debug(`Failed to get earliest timestamp for ${filePath}:`, error);
		return null;
	}
}

/**
 * Sort files by their earliest timestamp
 * Files without valid timestamps are placed at the end
 */
export async function sortFilesByTimestamp(files: string[]): Promise<string[]> {
	const filesWithTimestamps = await Promise.all(
		files.map(async (file) => ({
			file,
			timestamp: await getEarliestTimestamp(file),
		})),
	);

	return filesWithTimestamps
		.sort((a, b) => {
			// Files without timestamps go to the end
			if (a.timestamp == null && b.timestamp == null) {
				return 0;
			}
			if (a.timestamp == null) {
				return 1;
			}
			if (b.timestamp == null) {
				return -1;
			}
			// Sort by timestamp (oldest first)
			return a.timestamp.getTime() - b.timestamp.getTime();
		})
		.map((item) => item.file);
}

/**
 * Calculates cost for a single usage data entry based on the specified cost calculation mode
 * @param data - Usage data entry
 * @param mode - Cost calculation mode (auto, calculate, or display)
 * @param fetcher - Pricing fetcher instance for calculating costs from tokens
 * @returns Calculated cost in USD
 */
export async function calculateCostForEntry(
	data: UsageData,
	mode: CostMode,
	fetcher: PricingFetcher,
): Promise<number> {
	const speed = data.message.usage.speed;

	if (mode === 'display') {
		// Always use costUSD, even if undefined
		return data.costUSD ?? 0;
	}

	if (mode === 'calculate') {
		// Always calculate from tokens
		if (data.message.model != null) {
			return Result.unwrap(
				fetcher.calculateCostFromTokens(data.message.usage, data.message.model, { speed }),
				0,
			);
		}
		return 0;
	}

	if (mode === 'auto') {
		// Auto mode: use costUSD if available, otherwise calculate
		if (data.costUSD != null) {
			return data.costUSD;
		}

		if (data.message.model != null) {
			return Result.unwrap(
				fetcher.calculateCostFromTokens(data.message.usage, data.message.model, { speed }),
				0,
			);
		}

		return 0;
	}

	unreachable(mode);
}

function getImmediateCostForEntry(data: UsageData, mode: CostMode): number | undefined {
	if (mode === 'display') {
		return data.costUSD ?? 0;
	}

	if (mode === 'auto' && data.costUSD != null) {
		return data.costUSD;
	}

	return undefined;
}

type CostCalculator = (data: UsageData) => number;

async function createCostCalculator(
	mode: CostMode,
	fetcher: PricingFetcher | null,
	pricingOverride?: Map<string, LiteLLMModelPricing>,
): Promise<CostCalculator> {
	if (mode === 'display') {
		return (data) => data.costUSD ?? 0;
	}

	if (fetcher == null && pricingOverride == null) {
		return () => 0;
	}

	const pricing =
		pricingOverride ??
		Result.unwrap(await fetcher!.fetchModelPricing(), new Map<string, LiteLLMModelPricing>());
	const pricingCalculator = fetcher ?? new PricingFetcher(true);
	const modelPricingCache = new Map<string, LiteLLMModelPricing | null>();

	const getModelPricing = (modelName: string): LiteLLMModelPricing | null => {
		if (modelPricingCache.has(modelName)) {
			return modelPricingCache.get(modelName) ?? null;
		}

		const direct = pricing.get(modelName);
		if (direct != null) {
			modelPricingCache.set(modelName, direct);
			return direct;
		}

		for (const prefix of CLAUDE_PROVIDER_PREFIXES) {
			const prefixed = pricing.get(`${prefix}${modelName}`);
			if (prefixed != null) {
				modelPricingCache.set(modelName, prefixed);
				return prefixed;
			}
		}

		const lower = modelName.toLowerCase();
		for (const [key, value] of pricing) {
			const comparison = key.toLowerCase();
			if (comparison.includes(lower) || lower.includes(comparison)) {
				modelPricingCache.set(modelName, value);
				return value;
			}
		}

		modelPricingCache.set(modelName, null);
		return null;
	};

	return (data) => {
		if (mode === 'auto' && data.costUSD != null) {
			return data.costUSD;
		}

		const model = data.message.model;
		if (model == null || model === '') {
			return 0;
		}

		const modelPricing = getModelPricing(model);
		if (modelPricing == null) {
			return 0;
		}

		const baseCost = pricingCalculator.calculateCostFromPricing(data.message.usage, modelPricing);
		return (
			baseCost *
			(data.message.usage.speed === 'fast' ? (modelPricing.provider_specific_entry?.fast ?? 1) : 1)
		);
	};
}

/**
 * Get Claude Code usage limit expiration date
 * @param data - Usage data entry
 * @returns Usage limit expiration date
 */
export function getUsageLimitResetTime(data: UsageData): Date | null {
	let resetTime: Date | null = null;

	if (data.isApiErrorMessage === true) {
		const timestampMatch =
			data.message?.content
				?.find((c) => c.text != null && c.text.includes('Claude AI usage limit reached'))
				?.text?.match(/\|(\d+)/) ?? null;

		if (timestampMatch?.[1] != null) {
			const resetTimestamp = Number.parseInt(timestampMatch[1]);
			resetTime = resetTimestamp > 0 ? new Date(resetTimestamp * 1000) : null;
		}
	}

	return resetTime;
}

/**
 * Result of glob operation with base directory information
 */
export type GlobResult = {
	file: string;
	baseDir: string;
};

export async function collectJsonlFiles(root: string): Promise<string[]> {
	const files: string[] = [];
	const walkDirectory = async (dir: string): Promise<void> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		let childDirectoryWalks: Array<Promise<void>> | undefined;
		for (const entry of entries) {
			const filePath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (childDirectoryWalks == null) {
					childDirectoryWalks = [];
				}
				childDirectoryWalks.push(walkDirectory(filePath));
			} else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
				files.push(filePath);
			}
		}
		if (childDirectoryWalks != null) {
			await Promise.all(childDirectoryWalks);
		}
	};
	await walkDirectory(root);
	return files.sort(compareStrings);
}

/**
 * Glob files from multiple Claude paths in parallel
 * @param claudePaths - Array of Claude base paths
 * @returns Array of file paths with their base directories
 */
export async function globUsageFiles(claudePaths: string[]): Promise<GlobResult[]> {
	const filePromises = claudePaths.map(async (claudePath) => {
		const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
		const files = await collectJsonlFiles(claudeDir);

		return files.map((file) => ({ file, baseDir: claudeDir }));
	});
	return (await Promise.all(filePromises)).flat();
}

/**
 * Date range filter for limiting usage data by date
 */
export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

/**
 * Configuration options for loading usage data
 */
export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
	order?: SortOrder; // Sort order for dates
	offline?: boolean; // Use offline mode for pricing
	sessionDurationHours?: number; // Session block duration in hours
	groupByProject?: boolean; // Group data by project instead of aggregating
	project?: string; // Filter to specific project name
	startOfWeek?: WeekDay; // Start of week for weekly aggregation
	timezone?: string; // Timezone for date grouping (e.g., 'UTC', 'America/New_York'). Defaults to system timezone
	minUpdateTime?: Date; // Only process files modified after this timestamp
	singleThread?: boolean; // Disable parallel JSONL file loading
} & DateFilter;

type DailyDataEntry = {
	date: string;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	model: string | undefined;
	project: string;
	uniqueHash: string | null;
	tokenTotal: number;
	hasSpeed: boolean;
};

type EncodedDailyDataEntries = {
	kind: 'daily-columns';
	count: number;
	numbers: Float64Array;
	flags: Uint8Array;
	project: string;
	strings: Array<string | null>;
};

type SessionDataEntry = {
	sessionKey: string;
	sessionId: string;
	projectPath: string;
	cost: number;
	timestamp: string;
	model: string | undefined;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	uniqueHash: string | null;
	tokenTotal: number;
	hasSpeed: boolean;
	version: Version | undefined;
};

type EncodedSessionDataEntries = {
	kind: 'session-columns';
	count: number;
	numbers: Float64Array;
	flags: Uint8Array;
	sessionKey: string;
	sessionId: string;
	projectPath: string;
	strings: Array<string | null>;
};

type BlockEntryResult = {
	entry: LoadedUsageEntry;
	uniqueHash: string | null;
	tokenTotal: number;
	hasSpeed: boolean;
};

type BlockFileResult = {
	file: string;
	timestampMs: number | null;
	entries: BlockEntryResult[];
};

type DedupedEntryIndex = Record<string, number | undefined>;

type DedupedBlockEntryMetadata = {
	tokenTotal: number;
	hasSpeed: boolean;
	index: number;
};

type DedupedBlockEntryIndex = Record<string, DedupedBlockEntryMetadata | undefined>;

/**
 * Create a null-prototype string lookup for hot dedupe indexes.
 *
 * Global dedupe uses Claude message/request IDs as plain string keys and only needs exact-key
 * lookup. Bun profiles showed native `Map#set` dominating the post-worker merge, so this avoids
 * the Map bucket machinery while staying safe for arbitrary keys through the null prototype.
 */
function createDedupedEntryIndex(): DedupedEntryIndex {
	return Object.create(null) as DedupedEntryIndex;
}

/**
 * Create the block variant of the string lookup, which stores replacement metadata with each key.
 */
function createDedupedBlockEntryIndex(): DedupedBlockEntryIndex {
	return Object.create(null) as DedupedBlockEntryIndex;
}

type EncodedBlockFileResult = {
	kind: 'block-columns';
	file: string;
	timestampMs: number | null;
	count: number;
	numbers: Float64Array;
	flags: Uint8Array;
	strings: Array<string | null>;
};

type UsageWorkerTask = 'daily' | 'session' | 'blocks';

type IndexedWorkerItem<T> = {
	index: number;
	item: T;
};

type UsageWorkerData = {
	kind: 'ccusage:usage-worker';
	task: UsageWorkerTask;
	items: Array<IndexedWorkerItem<unknown>>;
	mode: CostMode;
	offline: boolean | undefined;
	timezone: string | undefined;
	pricing: Map<string, LiteLLMModelPricing> | undefined;
};

type UsageWorkerResponse<TResult> = {
	results: Array<{
		index: number;
		result: TResult;
	}>;
};

function shouldReplaceEntryMetadata(
	candidate: { tokenTotal: number; hasSpeed: boolean },
	existing: { tokenTotal: number; hasSpeed: boolean },
): boolean {
	if (candidate.tokenTotal !== existing.tokenTotal) {
		return candidate.tokenTotal > existing.tokenTotal;
	}

	return candidate.hasSpeed && !existing.hasSpeed;
}

function markDedupedEntryMetadata(
	processedEntries: DedupedEntryIndex,
	entry: { uniqueHash: string | null },
	entryIndex: number,
): void {
	if (entry.uniqueHash != null) {
		processedEntries[entry.uniqueHash] = entryIndex;
	}
}

/**
 * Pack daily worker rows into column arrays before posting them back to the main thread.
 *
 * The numeric columns are transferred instead of cloned, and the string columns stay in a flat array.
 * Each payload represents one JSONL file, so `project` is stored once instead of cloned for every
 * row. This keeps worker messaging smaller than sending one object per parsed usage row while
 * preserving the main-thread dedupe and aggregation rules.
 */
function encodeDailyDataEntries(entries: DailyDataEntry[]): EncodedDailyDataEntries {
	const count = entries.length;
	const numbers = new Float64Array(count * 6);
	const flags = new Uint8Array(count);
	const strings: Array<string | null> = [];
	strings.length = count * 3;
	const firstEntry = entries[0];

	for (let index = 0; index < count; index++) {
		const entry = entries[index]!;
		const numberOffset = index * 6;
		numbers[numberOffset] = entry.cost;
		numbers[numberOffset + 1] = entry.inputTokens;
		numbers[numberOffset + 2] = entry.outputTokens;
		numbers[numberOffset + 3] = entry.cacheCreationTokens;
		numbers[numberOffset + 4] = entry.cacheReadTokens;
		numbers[numberOffset + 5] = entry.tokenTotal;
		flags[index] = entry.hasSpeed ? 1 : 0;

		const stringOffset = index * 3;
		strings[stringOffset] = entry.date;
		strings[stringOffset + 1] = entry.model ?? null;
		strings[stringOffset + 2] = entry.uniqueHash;
	}

	return {
		kind: 'daily-columns',
		count,
		numbers,
		flags,
		project: firstEntry?.project ?? '',
		strings,
	};
}

function decodeDailyDataEntries(encoded: EncodedDailyDataEntries): DailyDataEntry[] {
	const entries: DailyDataEntry[] = [];
	forEachDailyDataEntry(encoded, (entry) => {
		entries.push(entry);
	});
	return entries;
}

/**
 * Reconstruct daily rows from the transferred worker columns one row at a time.
 *
 * The worker payload deliberately separates numeric columns from string columns so the numeric
 * buffers can be transferred instead of structured-cloned. Iterating through this helper lets the
 * main thread feed rows directly into dedupe/aggregation without first rebuilding a large decoded
 * array, while `decodeDailyDataEntries` keeps a full-array path available for focused tests.
 */
function forEachDailyDataEntry(
	encoded: EncodedDailyDataEntries,
	onEntry: (entry: DailyDataEntry) => void,
): void {
	for (let index = 0; index < encoded.count; index++) {
		const numberOffset = index * 6;
		const stringOffset = index * 3;
		onEntry({
			date: encoded.strings[stringOffset]!,
			cost: encoded.numbers[numberOffset]!,
			inputTokens: encoded.numbers[numberOffset + 1]!,
			outputTokens: encoded.numbers[numberOffset + 2]!,
			cacheCreationTokens: encoded.numbers[numberOffset + 3]!,
			cacheReadTokens: encoded.numbers[numberOffset + 4]!,
			model: encoded.strings[stringOffset + 1] ?? undefined,
			project: encoded.project,
			uniqueHash: encoded.strings[stringOffset + 2] ?? null,
			tokenTotal: encoded.numbers[numberOffset + 5]!,
			hasSpeed: encoded.flags[index] === 1,
		});
	}
}

/**
 * Use the same columnar worker payload shape for session rows as daily rows.
 *
 * Each encoded session payload represents one JSONL file, so `sessionKey`, `sessionId`, and
 * `projectPath` are file-level constants. Keeping those strings outside the per-row side array
 * avoids repeatedly cloning identical metadata when workers return many rows from one session file.
 */
function encodeSessionDataEntries(entries: SessionDataEntry[]): EncodedSessionDataEntries {
	const count = entries.length;
	const numbers = new Float64Array(count * 6);
	const flags = new Uint8Array(count);
	const strings: Array<string | null> = [];
	strings.length = count * 4;
	const firstEntry = entries[0];

	for (let index = 0; index < count; index++) {
		const entry = entries[index]!;
		const numberOffset = index * 6;
		numbers[numberOffset] = entry.cost;
		numbers[numberOffset + 1] = entry.inputTokens;
		numbers[numberOffset + 2] = entry.outputTokens;
		numbers[numberOffset + 3] = entry.cacheCreationTokens;
		numbers[numberOffset + 4] = entry.cacheReadTokens;
		numbers[numberOffset + 5] = entry.tokenTotal;
		flags[index] = entry.hasSpeed ? 1 : 0;

		const stringOffset = index * 4;
		strings[stringOffset] = entry.timestamp;
		strings[stringOffset + 1] = entry.model ?? null;
		strings[stringOffset + 2] = entry.uniqueHash;
		strings[stringOffset + 3] = entry.version ?? null;
	}

	return {
		kind: 'session-columns',
		count,
		numbers,
		flags,
		sessionKey: firstEntry?.sessionKey ?? '',
		sessionId: firstEntry?.sessionId ?? '',
		projectPath: firstEntry?.projectPath ?? '',
		strings,
	};
}

function decodeSessionDataEntries(encoded: EncodedSessionDataEntries): SessionDataEntry[] {
	const entries: SessionDataEntry[] = [];
	forEachSessionDataEntry(encoded, (entry) => {
		entries.push(entry);
	});
	return entries;
}

/**
 * Reconstruct session rows lazily from columnar worker output.
 *
 * Session rows have more string fields than daily rows, but the same transfer-list trade-off applies:
 * numbers and flags stay in typed arrays, and strings stay in a flat side array. Keeping the iterator
 * as the hot-path API avoids a second decoded array when the caller only needs to merge each row once.
 */
function forEachSessionDataEntry(
	encoded: EncodedSessionDataEntries,
	onEntry: (entry: SessionDataEntry) => void,
): void {
	for (let index = 0; index < encoded.count; index++) {
		const numberOffset = index * 6;
		const stringOffset = index * 4;
		onEntry({
			sessionKey: encoded.sessionKey,
			sessionId: encoded.sessionId,
			projectPath: encoded.projectPath,
			cost: encoded.numbers[numberOffset]!,
			timestamp: encoded.strings[stringOffset]!,
			model: encoded.strings[stringOffset + 1] ?? undefined,
			inputTokens: encoded.numbers[numberOffset + 1]!,
			outputTokens: encoded.numbers[numberOffset + 2]!,
			cacheCreationTokens: encoded.numbers[numberOffset + 3]!,
			cacheReadTokens: encoded.numbers[numberOffset + 4]!,
			uniqueHash: encoded.strings[stringOffset + 2] ?? null,
			tokenTotal: encoded.numbers[numberOffset + 5]!,
			hasSpeed: encoded.flags[index] === 1,
			version: (encoded.strings[stringOffset + 3] ?? undefined) as Version | undefined,
		});
	}
}

/**
 * Pack block worker rows before crossing the worker boundary.
 *
 * Blocks need `Date` instances again on the main thread, but sending timestamps as numbers avoids
 * cloning nested entry objects and lets the main thread reconstruct the small object graph once.
 */
function encodeBlockFileResult(result: BlockFileResult): EncodedBlockFileResult {
	const count = result.entries.length;
	const numbers = new Float64Array(count * 8);
	const flags = new Uint8Array(count);
	const strings: Array<string | null> = [];
	strings.length = count * 3;

	for (let index = 0; index < count; index++) {
		const entry = result.entries[index]!;
		const numberOffset = index * 8;
		const timestampMs = entry.entry.timestampMs ?? entry.entry.timestamp.getTime();
		numbers[numberOffset] = timestampMs;
		numbers[numberOffset + 1] = entry.entry.costUSD ?? 0;
		numbers[numberOffset + 2] = entry.entry.usage.inputTokens;
		numbers[numberOffset + 3] = entry.entry.usage.outputTokens;
		numbers[numberOffset + 4] = entry.entry.usage.cacheCreationInputTokens;
		numbers[numberOffset + 5] = entry.entry.usage.cacheReadInputTokens;
		numbers[numberOffset + 6] = entry.tokenTotal;
		numbers[numberOffset + 7] = entry.entry.usageLimitResetTime?.getTime() ?? Number.NaN;
		flags[index] = entry.hasSpeed ? 1 : 0;

		const stringOffset = index * 3;
		strings[stringOffset] = entry.entry.model;
		strings[stringOffset + 1] = entry.uniqueHash;
		strings[stringOffset + 2] = entry.entry.version ?? null;
	}

	return {
		kind: 'block-columns',
		file: result.file,
		timestampMs: result.timestampMs,
		count,
		numbers,
		flags,
		strings,
	};
}

function decodeBlockFileResult(encoded: EncodedBlockFileResult): BlockFileResult {
	const entries: BlockEntryResult[] = [];
	forEachBlockEntry(encoded, (entry) => {
		entries.push(entry);
	});

	return {
		file: encoded.file,
		timestampMs: encoded.timestampMs,
		entries,
	};
}

/**
 * Iterate encoded block worker rows without first rebuilding a nested result array.
 *
 * Blocks carry more per-row fields than daily/session results, so decoding every worker response
 * into `{ entries: [...] }` allocates a second full copy before global dedupe immediately walks it.
 * This iterator keeps the normal decoder available for tests/debugging, while the hot worker merge
 * path can reconstruct one row at a time and discard duplicate rows before materializing anything
 * beyond the final `allEntries` output.
 */
function forEachBlockEntry(
	encoded: EncodedBlockFileResult,
	onEntry: (entry: BlockEntryResult) => void,
): void {
	for (let index = 0; index < encoded.count; index++) {
		const numberOffset = index * 8;
		const stringOffset = index * 3;
		const timestampMs = encoded.numbers[numberOffset]!;
		const usageLimitResetTimeMs = encoded.numbers[numberOffset + 7]!;
		onEntry({
			entry: {
				timestamp: new Date(timestampMs),
				timestampMs,
				usage: {
					inputTokens: encoded.numbers[numberOffset + 2]!,
					outputTokens: encoded.numbers[numberOffset + 3]!,
					cacheCreationInputTokens: encoded.numbers[numberOffset + 4]!,
					cacheReadInputTokens: encoded.numbers[numberOffset + 5]!,
				},
				costUSD: encoded.numbers[numberOffset + 1]!,
				model: encoded.strings[stringOffset] ?? 'unknown',
				version: encoded.strings[stringOffset + 2] ?? undefined,
				usageLimitResetTime: Number.isNaN(usageLimitResetTimeMs)
					? undefined
					: new Date(usageLimitResetTimeMs),
			},
			uniqueHash: encoded.strings[stringOffset + 1] ?? null,
			tokenTotal: encoded.numbers[numberOffset + 6]!,
			hasSpeed: encoded.flags[index] === 1,
		});
	}
}

function getJSONLWorkerThreadCount(
	fileCount: number,
	singleThread = false,
	preferMoreWorkers = false,
): number {
	if (
		singleThread ||
		fileCount < 64 ||
		!isMainThread ||
		import.meta.vitest != null ||
		!import.meta.url.includes('/dist/')
	) {
		return 0;
	}

	const configured = Number.parseInt(process.env.CCUSAGE_JSONL_WORKER_THREADS ?? '', 10);
	if (Number.isFinite(configured)) {
		if (configured <= 0) {
			return 0;
		}
		return Math.min(fileCount, configured);
	}

	return getDefaultJSONLWorkerThreadCount(fileCount, preferMoreWorkers);
}

function chunkIndexedItems<T>(
	items: Array<IndexedWorkerItem<T>>,
	chunkCount: number,
): Array<Array<IndexedWorkerItem<T>>> {
	const chunks: Array<Array<IndexedWorkerItem<T>>> = Array.from({ length: chunkCount }, () => []);
	for (let index = 0; index < items.length; index++) {
		chunks[index % chunkCount]!.push(items[index]!);
	}
	return chunks.filter((chunk) => chunk.length > 0);
}

async function chunkIndexedItemsByFileSize<T>(
	items: Array<IndexedWorkerItem<T>>,
	chunkCount: number,
	getFilePath: (item: T) => string,
): Promise<Array<Array<IndexedWorkerItem<T>>>> {
	const weightedItems = await Promise.all(
		items.map(async (item) => {
			try {
				return { item, weight: (await stat(getFilePath(item.item))).size };
			} catch {
				return { item, weight: 0 };
			}
		}),
	);

	weightedItems.sort((a, b) => b.weight - a.weight || a.item.index - b.item.index);

	const chunks: Array<Array<IndexedWorkerItem<T>>> = Array.from({ length: chunkCount }, () => []);
	const chunkWeights = Array.from<number>({ length: chunkCount }).fill(0);
	for (const { item, weight } of weightedItems) {
		let targetIndex = 0;
		for (let index = 1; index < chunkWeights.length; index++) {
			if (chunkWeights[index]! < chunkWeights[targetIndex]!) {
				targetIndex = index;
			}
		}
		chunks[targetIndex]!.push(item);
		chunkWeights[targetIndex]! += weight;
	}

	return chunks.filter((chunk) => chunk.length > 0);
}

async function collectWithUsageWorkers<TItem, TResult>(
	task: UsageWorkerTask,
	items: TItem[],
	options: {
		mode: CostMode;
		offline: boolean | undefined;
		timezone: string | undefined;
		singleThread: boolean | undefined;
		getFilePath?: (item: TItem) => string;
	},
): Promise<TResult[] | null> {
	const workerCount = getJSONLWorkerThreadCount(
		items.length,
		options.singleThread,
		task === 'daily' || task === 'session',
	);
	if (workerCount === 0) {
		return null;
	}

	const indexedItems = items.map<IndexedWorkerItem<TItem>>((item, index) => ({ index, item }));
	const chunks =
		options.getFilePath == null
			? chunkIndexedItems(indexedItems, workerCount)
			: await chunkIndexedItemsByFileSize(indexedItems, workerCount, options.getFilePath);
	let pricing: Map<string, LiteLLMModelPricing> | undefined;
	if (options.mode !== 'display' && options.offline !== true) {
		using fetcher = new PricingFetcher(options.offline);
		pricing = Result.unwrap(
			await fetcher.fetchModelPricing(),
			new Map<string, LiteLLMModelPricing>(),
		);
	}
	const workerResults: Array<Promise<Array<{ index: number; result: TResult }>>> = [];
	for (const chunk of chunks) {
		workerResults.push(
			new Promise<Array<{ index: number; result: TResult }>>((resolve, reject) => {
				const worker = new Worker(new URL(import.meta.url), {
					workerData: {
						kind: 'ccusage:usage-worker',
						task,
						items: chunk,
						mode: options.mode,
						offline: options.offline,
						timezone: options.timezone,
						pricing,
					} satisfies UsageWorkerData,
				});
				worker.once('message', (message: UsageWorkerResponse<TResult>) => {
					resolve(message.results);
				});
				worker.once('error', reject);
				worker.once('exit', (code) => {
					if (code !== 0) {
						reject(new Error(`ccusage worker exited with code ${code}`));
					}
				});
			}),
		);
	}
	const resultGroups = await Promise.all(workerResults);
	const orderedResults = createResultSlots<TResult>(items.length);
	for (const results of resultGroups) {
		for (const { index, result } of results) {
			orderedResults[index] = result;
		}
	}

	return orderedResults;
}

async function collectDailyEntriesFromFile(
	file: string,
	calculateCost: CostCalculator,
	formatUsageDate: (dateStr: string) => string,
): Promise<DailyDataEntry[]> {
	const project = extractProjectFromPath(file);
	const entries: DailyDataEntry[] = [];
	const processedEntries = createDedupedEntryIndex();

	await processJSONLUsageFileByLine(file, (line, usageMarkerIndex) => {
		try {
			const data = parseUsageDataLine(line, { usageMarkerIndex });
			if (data == null) {
				return;
			}

			const date = formatUsageDate(data.timestamp);
			const uniqueHash = createUniqueHash(data);
			const usage = data.message.usage;
			const tokenTotal = sumUsageTokens(usage);
			const hasSpeed = usage.speed != null;
			let existingEntryIndex: number | undefined;
			if (uniqueHash != null) {
				existingEntryIndex = processedEntries[uniqueHash];
				if (
					existingEntryIndex != null &&
					!shouldReplaceEntryMetadata({ tokenTotal, hasSpeed }, entries[existingEntryIndex]!)
				) {
					return;
				}
			}

			const model = data.message.model;
			const entry = {
				date,
				cost: calculateCost(data),
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
				cacheReadTokens: usage.cache_read_input_tokens ?? 0,
				model: formatUsageModelName(model, usage.speed),
				project,
				uniqueHash,
				tokenTotal,
				hasSpeed,
			};
			if (existingEntryIndex != null) {
				entries[existingEntryIndex] = entry;
			} else {
				entries.push(entry);
				markDedupedEntryMetadata(processedEntries, entry, entries.length - 1);
			}
		} catch {
			// Skip invalid JSON lines
		}
	});

	return entries;
}

async function collectSessionEntriesFromFile(
	item: GlobResult,
	mode: CostMode,
	calculateCost: CostCalculator,
): Promise<SessionDataEntry[]> {
	const { file, baseDir } = item;
	const relativePath = path.relative(baseDir, file);
	const parts = relativePath.split(path.sep);
	const sessionId = parts[parts.length - 2] ?? 'unknown';
	const joinedPath = parts.slice(0, -2).join(path.sep);
	const projectPath = joinedPath.length > 0 ? joinedPath : 'Unknown Project';
	const entries: SessionDataEntry[] = [];
	const processedEntries = createDedupedEntryIndex();

	await processJSONLUsageFileByLine(file, (line, usageMarkerIndex) => {
		try {
			const data = parseUsageDataLine(line, { usageMarkerIndex });
			if (data == null) {
				return;
			}

			const immediateCost = getImmediateCostForEntry(data, mode);
			const uniqueHash = createUniqueHash(data);
			const usage = data.message.usage;
			const tokenTotal = sumUsageTokens(usage);
			const hasSpeed = usage.speed != null;
			let existingEntryIndex: number | undefined;
			if (uniqueHash != null) {
				existingEntryIndex = processedEntries[uniqueHash];
				if (
					existingEntryIndex != null &&
					!shouldReplaceEntryMetadata({ tokenTotal, hasSpeed }, entries[existingEntryIndex]!)
				) {
					return;
				}
			}

			const model = data.message.model;
			const entry = {
				sessionKey: `${projectPath}/${sessionId}`,
				sessionId,
				projectPath,
				cost: immediateCost ?? calculateCost(data),
				timestamp: data.timestamp,
				model: formatUsageModelName(model, usage.speed),
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
				cacheReadTokens: usage.cache_read_input_tokens ?? 0,
				version: data.version,
				uniqueHash,
				tokenTotal,
				hasSpeed,
			};
			if (existingEntryIndex != null) {
				entries[existingEntryIndex] = entry;
			} else {
				entries.push(entry);
				markDedupedEntryMetadata(processedEntries, entry, entries.length - 1);
			}
		} catch {
			// Skip invalid JSON lines
		}
	});

	return entries;
}

async function collectBlockFileResult(
	file: string,
	calculateCost: CostCalculator,
): Promise<BlockFileResult> {
	let timestampMs: number | null = null;
	const entries: BlockEntryResult[] = [];
	const processedEntries = createDedupedEntryIndex();

	const setEarliestTimestamp = (lineTimestamp: Date, lineTimestampMs: number): void => {
		if (!Number.isNaN(lineTimestampMs) && (timestampMs == null || lineTimestampMs < timestampMs)) {
			timestampMs = lineTimestampMs;
		}
	};

	const processLine = (line: string, usageMarkerIndex: number): void => {
		try {
			const data = parseUsageDataLine(line, { usageMarkerIndex });
			if (data == null) {
				return;
			}
			const parsedTimestampMs = parseIsoTimestampMs(data.timestamp);
			const lineTimestamp = Number.isNaN(parsedTimestampMs)
				? new Date(data.timestamp)
				: new Date(parsedTimestampMs);
			setEarliestTimestamp(
				lineTimestamp,
				Number.isNaN(parsedTimestampMs) ? lineTimestamp.getTime() : parsedTimestampMs,
			);

			const uniqueHash = createUniqueHash(data);
			const usage = data.message.usage;
			const tokenTotal = sumUsageTokens(usage);
			const hasSpeed = usage.speed != null;
			let existingEntryIndex: number | undefined;
			if (uniqueHash != null) {
				existingEntryIndex = processedEntries[uniqueHash];
				if (
					existingEntryIndex != null &&
					!shouldReplaceEntryMetadata({ tokenTotal, hasSpeed }, entries[existingEntryIndex]!)
				) {
					return;
				}
			}

			const usageLimitResetTime = getUsageLimitResetTime(data);
			const model = data.message.model;
			const entry: BlockEntryResult = {
				entry: {
					timestamp: lineTimestamp,
					timestampMs: Number.isNaN(parsedTimestampMs)
						? lineTimestamp.getTime()
						: parsedTimestampMs,
					usage: {
						inputTokens: usage.input_tokens,
						outputTokens: usage.output_tokens,
						cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
						cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
					},
					costUSD: calculateCost(data),
					model: formatUsageModelNameOrUnknown(model, usage.speed),
					version: data.version,
					usageLimitResetTime: usageLimitResetTime ?? undefined,
				},
				uniqueHash,
				tokenTotal,
				hasSpeed,
			};
			if (existingEntryIndex != null) {
				entries[existingEntryIndex] = entry;
			} else {
				entries.push(entry);
				markDedupedEntryMetadata(processedEntries, entry, entries.length - 1);
			}
		} catch (error) {
			logger.debug(
				`Skipping invalid JSON line in 5-hour blocks: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	await processJSONLUsageFileByLine(file, processLine);

	return {
		file,
		timestampMs,
		entries,
	};
}

/**
 * Loads and aggregates Claude usage data by day
 * Processes all JSONL files in the Claude projects directory and groups usage by date
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of daily usage summaries sorted by date
 */
export async function loadDailyUsageData(options?: LoadOptions): Promise<DailyUsage[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths in parallel
	const allFiles = await globUsageFiles(claudePaths);
	const fileList = allFiles.map((f) => f.file);

	if (fileList.length === 0) {
		return [];
	}

	// Filter by project if specified
	const projectFilteredFiles = filterByProject(
		fileList,
		(filePath) => extractProjectFromPath(filePath),
		options?.project,
	);
	const mtimeFilteredFiles = await filterFilesByMtime(
		projectFilteredFiles,
		(filePath) => filePath,
		options?.since,
		options?.minUpdateTime,
	);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	const formatUsageDate = createCachedDateFormatter(options?.timezone);

	const allEntries: DailyDataEntry[] = [];
	// The merge loop writes stable indexes for dedupe replacement, so a local length counter keeps
	// appends explicit without asking Array#push to update and return the length on every usage row.
	let allEntriesLength = 0;
	const processedEntries = createDedupedEntryIndex();
	const mergeEntry = (entry: DailyDataEntry): void => {
		if (entry.uniqueHash != null) {
			const existingEntryIndex = processedEntries[entry.uniqueHash];
			if (existingEntryIndex != null) {
				if (!shouldReplaceEntryMetadata(entry, allEntries[existingEntryIndex]!)) {
					return;
				}
				allEntries[existingEntryIndex] = entry;
				return;
			}

			processedEntries[entry.uniqueHash] = allEntriesLength;
		}

		allEntries[allEntriesLength++] = entry;
	};

	const workerFileResults = await collectWithUsageWorkers<string, EncodedDailyDataEntries>(
		'daily',
		mtimeFilteredFiles,
		{
			mode,
			offline: options?.offline,
			timezone: options?.timezone,
			singleThread: options?.singleThread,
			getFilePath: (file) => file,
		},
	);
	if (workerFileResults == null) {
		using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);
		const calculateCost = await createCostCalculator(mode, fetcher);
		const fallbackFileResults = await mapWithConcurrency(
			mtimeFilteredFiles,
			getJSONLFileReadConcurrency(mtimeFilteredFiles.length, options?.singleThread),
			async (file): Promise<DailyDataEntry[]> =>
				collectDailyEntriesFromFile(file, calculateCost, formatUsageDate),
		);
		for (const entries of fallbackFileResults) {
			for (const entry of entries) {
				mergeEntry(entry);
			}
		}
	} else {
		for (const encodedEntries of workerFileResults) {
			forEachDailyDataEntry(encodedEntries, mergeEntry);
		}
	}

	// Group by date, optionally including project
	// Automatically enable project grouping when project filter is specified
	const needsProjectGrouping = options?.groupByProject === true || options?.project != null;
	const groupedData = new Map<
		string,
		{
			date: string;
			project: string | undefined;
			summary: UsageSummaryAccumulator;
		}
	>();

	for (const entry of allEntries) {
		const groupKey = needsProjectGrouping ? `${entry.date}\x00${entry.project}` : entry.date;
		let group = groupedData.get(groupKey);
		if (group == null) {
			group = {
				date: entry.date,
				project: needsProjectGrouping ? entry.project : undefined,
				summary: createUsageSummaryAccumulator(),
			};
			groupedData.set(groupKey, group);
		}
		addTokenFieldsToSummaryAccumulator(group.summary, entry.model, entry, entry.cost);
	}

	const results = Array.from(groupedData.values(), (group) => ({
		date: group.date as DailyDate,
		...finalizeUsageSummary(group.summary),
		...(group.project != null && { project: group.project }),
	}));

	// Filter by date range if specified
	const dateFiltered = filterByDateRange(
		results,
		(item) => item.date,
		options?.since,
		options?.until,
	);

	// Filter by project if specified
	const finalFiltered = filterByProject(dateFiltered, (item) => item.project, options?.project);

	// Sort by date based on order option (default to descending)
	return sortByDate(finalFiltered, (item) => item.date, options?.order);
}

/**
 * Loads and aggregates Claude usage data by session
 * Groups usage data by project path and session ID based on file structure
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of session usage summaries sorted by cost (highest first)
 */
export async function loadSessionData(options?: LoadOptions): Promise<SessionUsage[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths with their base directories in parallel
	const filesWithBase = await globUsageFiles(claudePaths);

	if (filesWithBase.length === 0) {
		return [];
	}

	// Filter by project if specified
	const projectFilteredWithBase = filterByProject(
		filesWithBase,
		(item) => extractProjectFromPath(item.file),
		options?.project,
	);
	const mtimeFilteredWithBase = await filterFilesByMtime(
		projectFilteredWithBase,
		(item) => item.file,
		options?.since,
		options?.minUpdateTime,
	);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	const formatUsageDate = createCachedDateFormatter(options?.timezone);

	// Collect all valid data entries with session info first
	const allEntries: SessionDataEntry[] = [];
	// Keep the append index stable for dedupe replacement while avoiding Array#push in this hot loop.
	let allEntriesLength = 0;
	const processedEntries = createDedupedEntryIndex();
	const mergeEntry = (entry: SessionDataEntry): void => {
		if (entry.uniqueHash != null) {
			const existingEntryIndex = processedEntries[entry.uniqueHash];
			if (existingEntryIndex != null) {
				if (!shouldReplaceEntryMetadata(entry, allEntries[existingEntryIndex]!)) {
					return;
				}
				allEntries[existingEntryIndex] = entry;
				return;
			}

			processedEntries[entry.uniqueHash] = allEntriesLength;
		}

		allEntries[allEntriesLength++] = entry;
	};

	const workerFileResults = await collectWithUsageWorkers<GlobResult, EncodedSessionDataEntries>(
		'session',
		mtimeFilteredWithBase,
		{
			mode,
			offline: options?.offline,
			timezone: options?.timezone,
			singleThread: options?.singleThread,
			getFilePath: (item) => item.file,
		},
	);
	if (workerFileResults == null) {
		using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);
		const calculateCost = await createCostCalculator(mode, fetcher);
		const fallbackFileResults = await mapWithConcurrency(
			mtimeFilteredWithBase,
			getJSONLFileReadConcurrency(mtimeFilteredWithBase.length, options?.singleThread),
			async (item): Promise<SessionDataEntry[]> =>
				collectSessionEntriesFromFile(item, mode, calculateCost),
		);
		for (const entries of fallbackFileResults) {
			for (const entry of entries) {
				mergeEntry(entry);
			}
		}
	} else {
		for (const encodedEntries of workerFileResults) {
			forEachSessionDataEntry(encodedEntries, mergeEntry);
		}
	}

	const groupedBySessions = new Map<
		string,
		{
			latestEntry: SessionDataEntry;
			summary: UsageSummaryAccumulator;
			versions: Set<string>;
		}
	>();

	for (const entry of allEntries) {
		let group = groupedBySessions.get(entry.sessionKey);
		if (group == null) {
			group = {
				latestEntry: entry,
				summary: createUsageSummaryAccumulator(),
				versions: new Set<string>(),
			};
			groupedBySessions.set(entry.sessionKey, group);
		} else if (entry.timestamp > group.latestEntry.timestamp) {
			group.latestEntry = entry;
		}

		if (entry.version != null) {
			group.versions.add(entry.version);
		}
		addTokenFieldsToSummaryAccumulator(group.summary, entry.model, entry, entry.cost);
	}

	const results = Array.from(groupedBySessions.values(), (group) => ({
		sessionId: createSessionId(group.latestEntry.sessionId),
		projectPath: group.latestEntry.projectPath as ProjectPath,
		...finalizeUsageSummary(group.summary),
		lastActivity: formatUsageDate(group.latestEntry.timestamp) as ActivityDate,
		versions: Array.from(group.versions).sort() as Version[],
	}));

	// Filter by date range if specified
	const dateFiltered = filterByDateRange(
		results,
		(item) => item.lastActivity,
		options?.since,
		options?.until,
	);

	// Filter by project if specified
	const sessionFiltered = filterByProject(
		dateFiltered,
		(item) => item.projectPath,
		options?.project,
	);

	// Sort sessions by cost (highest first by default), as documented
	const order = options?.order ?? 'desc';
	switch (order) {
		case 'asc':
			return sessionFiltered.toSorted((a, b) => a.totalCost - b.totalCost);
		case 'desc':
			return sessionFiltered.toSorted((a, b) => b.totalCost - a.totalCost);
		default:
			unreachable(order);
	}
}

/**
 * Loads and aggregates Claude usage data by month
 * Uses daily usage data as the source and groups by month
 * @param options - Optional configuration for loading and filtering data
 * @returns Array of monthly usage summaries sorted by month
 */
export async function loadMonthlyUsageData(options?: LoadOptions): Promise<MonthlyUsage[]> {
	return loadBucketUsageData(
		(data: DailyUsage) => data.date.slice(0, 7) as MonthlyDate,
		options,
	).then((usages) =>
		usages.map<MonthlyUsage>(({ bucket, ...rest }) => ({
			month: bucket as MonthlyDate,
			...rest,
		})),
	);
}

export async function loadWeeklyUsageData(options?: LoadOptions): Promise<WeeklyUsage[]> {
	const startDay =
		options?.startOfWeek != null ? getDayNumber(options.startOfWeek) : getDayNumber('sunday');

	return loadBucketUsageData(
		(data: DailyUsage) => getDateStringWeek(data.date, startDay),
		options,
	).then((usages) =>
		usages.map<WeeklyUsage>(({ bucket, ...rest }) => ({
			week: bucket as WeeklyDate,
			...rest,
		})),
	);
}

/**
 * Load usage data for a specific session by sessionId
 * Searches for a JSONL file named {sessionId}.jsonl in all Claude project directories
 * @param sessionId - The session ID to load data for (matches the JSONL filename)
 * @param options - Options for loading data
 * @param options.mode - Cost calculation mode (auto, calculate, display)
 * @param options.offline - Whether to use offline pricing data
 * @returns Usage data for the specific session or null if not found
 */
export async function loadSessionUsageById(
	sessionId: string,
	options?: { mode?: CostMode; offline?: boolean },
): Promise<{ totalCost: number; entries: UsageData[] } | null> {
	const claudePaths = getClaudePaths();

	const targetFile = `${sessionId}.jsonl`;
	let file: string | undefined;
	for (const claudePath of claudePaths) {
		const claudeDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
		file = (await collectJsonlFiles(claudeDir)).find(
			(candidate) => path.basename(candidate) === targetFile,
		);
		if (file != null) {
			break;
		}
	}
	if (file == null) {
		return null;
	}

	const mode = options?.mode ?? 'auto';
	using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);
	const calculateCost = await createCostCalculator(mode, fetcher);

	const entries: Array<UsageData | undefined> = [];
	let totalCost = 0;

	await processJSONLFileByLine(file, (line) => {
		try {
			if (!line.includes(USAGE_LINE_MARKER)) {
				return;
			}

			const data = parseUsageDataLine(line);
			if (data == null) {
				return;
			}

			const immediateCost = getImmediateCostForEntry(data, mode);
			totalCost += immediateCost ?? calculateCost(data);
			entries.push(data);
		} catch {
			// Skip invalid JSON lines
		}
	});

	return { totalCost, entries: entries.filter((entry): entry is UsageData => entry != null) };
}

export async function loadBucketUsageData(
	groupingFn: (data: DailyUsage) => Bucket,
	options?: LoadOptions,
): Promise<BucketUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	// Group daily data by week, optionally including project
	// Automatically enable project grouping when project filter is specified
	const needsProjectGrouping = options?.groupByProject === true || options?.project != null;

	const grouped = new Map<
		string,
		{
			bucket: Bucket;
			project: string | undefined;
			summary: UsageSummaryAccumulator;
		}
	>();

	for (const daily of dailyData) {
		const bucket = groupingFn(daily);
		const project = needsProjectGrouping ? (daily.project ?? 'unknown') : undefined;
		const groupKey = project == null ? bucket : `${bucket}\x00${project}`;
		let group = grouped.get(groupKey);
		if (group == null) {
			group = {
				bucket,
				project,
				summary: createUsageSummaryAccumulator(),
			};
			grouped.set(groupKey, group);
		}

		group.summary.totals.inputTokens += daily.inputTokens;
		group.summary.totals.outputTokens += daily.outputTokens;
		group.summary.totals.cacheCreationTokens += daily.cacheCreationTokens;
		group.summary.totals.cacheReadTokens += daily.cacheReadTokens;
		group.summary.totals.cost += daily.totalCost;
		group.summary.totals.totalCost += daily.totalCost;

		for (const model of daily.modelsUsed) {
			if (model !== '<synthetic>') {
				addModelUsed(group.summary, model);
			}
		}

		for (const breakdown of daily.modelBreakdowns) {
			if (breakdown.modelName === '<synthetic>') {
				continue;
			}
			let aggregate = group.summary.modelAggregates[breakdown.modelName];
			if (aggregate == null) {
				aggregate = createEmptyTokenStats();
				group.summary.modelAggregates[breakdown.modelName] = aggregate;
			}
			aggregate.inputTokens += breakdown.inputTokens;
			aggregate.outputTokens += breakdown.outputTokens;
			aggregate.cacheCreationTokens += breakdown.cacheCreationTokens;
			aggregate.cacheReadTokens += breakdown.cacheReadTokens;
			aggregate.cost += breakdown.cost;
		}
	}

	const buckets = Array.from(grouped.values(), (group): BucketUsage => {
		const summary = finalizeUsageSummary(group.summary);
		return {
			bucket: createBucket(group.bucket),
			inputTokens: summary.inputTokens,
			outputTokens: summary.outputTokens,
			cacheCreationTokens: summary.cacheCreationTokens,
			cacheReadTokens: summary.cacheReadTokens,
			totalCost: summary.totalCost,
			modelsUsed: summary.modelsUsed,
			modelBreakdowns: summary.modelBreakdowns,
			...(group.project != null && { project: group.project }),
		};
	});

	return sortByDate(buckets, (item) => item.bucket, options?.order);
}

/**
 * Calculate context tokens from transcript file using improved JSONL parsing
 * Based on the Python reference implementation for better accuracy
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns Object with context tokens info or null if unavailable
 */
export async function calculateContextTokens(
	transcriptPath: string,
	modelId?: string,
	offline = false,
): Promise<{
	inputTokens: number;
	percentage: number;
	contextLimit: number;
} | null> {
	let content: string;
	try {
		content = await readFile(transcriptPath, 'utf-8');
	} catch (error: unknown) {
		logger.debug(`Failed to read transcript file: ${String(error)}`);
		return null;
	}

	const lines = content.split('\n').reverse(); // Iterate from last line to first line

	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine === '') {
			continue;
		}

		try {
			const parsed = JSON.parse(trimmedLine) as unknown;
			const result = v.safeParse(transcriptMessageSchema, parsed);
			if (!result.success) {
				continue; // Skip malformed JSON lines
			}
			const obj = result.output;

			// Check if this line contains the required token usage fields
			if (
				obj.type === 'assistant' &&
				obj.message != null &&
				obj.message.usage != null &&
				obj.message.usage.input_tokens != null
			) {
				const usage = obj.message.usage;
				const inputTokens =
					usage.input_tokens! +
					(usage.cache_creation_input_tokens ?? 0) +
					(usage.cache_read_input_tokens ?? 0);

				// Get context limit from PricingFetcher
				let contextLimit = 200_000; // Fallback for when modelId is not provided
				if (modelId != null && modelId !== '') {
					using fetcher = new PricingFetcher(offline);
					const contextLimitResult = await fetcher.getModelContextLimit(modelId);
					if (Result.isSuccess(contextLimitResult) && contextLimitResult.value != null) {
						contextLimit = contextLimitResult.value;
					} else if (Result.isSuccess(contextLimitResult)) {
						// Context limit not available for this model in LiteLLM
						logger.debug(`No context limit data available for model ${modelId} in LiteLLM`);
					} else {
						// Error occurred
						logger.debug(
							`Failed to get context limit for model ${modelId}: ${contextLimitResult.error.message}`,
						);
					}
				}

				const percentage = Math.min(
					100,
					Math.max(0, Math.round((inputTokens / contextLimit) * 100)),
				);

				return {
					inputTokens,
					percentage,
					contextLimit,
				};
			}
		} catch {
			continue; // Skip malformed JSON lines
		}
	}

	// No valid usage information found
	logger.debug('No usage information found in transcript');
	return null;
}

/**
 * Keep block file ordering identical across decoded and encoded worker results.
 *
 * Worker results are produced by balanced chunks, not by file order. Sorting by the earliest usage
 * timestamp before global dedupe preserves the same replacement behavior as the non-worker path;
 * the file path tie-breaker keeps the ordering deterministic for logs with identical timestamps.
 */
function compareBlockFileResults(
	a: { file: string; timestampMs: number | null },
	b: { file: string; timestampMs: number | null },
): number {
	if (a.timestampMs == null && b.timestampMs == null) {
		return compareStrings(a.file, b.file);
	}
	if (a.timestampMs == null) {
		return 1;
	}
	if (b.timestampMs == null) {
		return -1;
	}
	const timestampDiff = a.timestampMs - b.timestampMs;
	return timestampDiff === 0 ? compareStrings(a.file, b.file) : timestampDiff;
}

/**
 * Loads usage data and organizes it into session blocks (typically 5-hour billing periods)
 * Processes all usage data and groups it into time-based blocks for billing analysis
 * @param options - Optional configuration including session duration and filtering
 * @returns Array of session blocks with usage and cost information
 */
export async function loadSessionBlockData(options?: LoadOptions): Promise<SessionBlock[]> {
	// Get all Claude paths or use the specific one from options
	const claudePaths = toArray(options?.claudePath ?? getClaudePaths());

	// Collect files from all paths
	const allFiles = (await globUsageFiles(claudePaths)).map((item) => item.file);

	if (allFiles.length === 0) {
		return [];
	}

	// Filter by project if specified
	const blocksFilteredFiles = filterByProject(
		allFiles,
		(filePath) => extractProjectFromPath(filePath),
		options?.project,
	);
	const mtimeFilteredFiles = await filterFilesByMtime(
		blocksFilteredFiles,
		(filePath) => filePath,
		options?.since,
		options?.minUpdateTime,
	);

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	const formatUsageDate = createCachedDateFormatter(options?.timezone);

	// Collect all valid data entries first
	const allEntries: LoadedUsageEntry[] = [];
	// Blocks keep replacement indexes in processedEntries, so the explicit length is the canonical
	// append position for both unique and non-hashed rows.
	let allEntriesLength = 0;
	const processedEntries = createDedupedBlockEntryIndex();
	const mergeBlockEntry = ({ entry, uniqueHash, tokenTotal, hasSpeed }: BlockEntryResult): void => {
		if (uniqueHash == null) {
			allEntries[allEntriesLength++] = entry;
			return;
		}

		const existing = processedEntries[uniqueHash];
		if (existing == null) {
			const index = allEntriesLength++;
			allEntries[index] = entry;
			processedEntries[uniqueHash] = { tokenTotal, hasSpeed, index };
			return;
		}
		if (shouldReplaceEntryMetadata({ tokenTotal, hasSpeed }, existing)) {
			allEntries[existing.index] = entry;
			processedEntries[uniqueHash] = { tokenTotal, hasSpeed, index: existing.index };
		}
	};

	const workerFileResults = await collectWithUsageWorkers<string, EncodedBlockFileResult>(
		'blocks',
		mtimeFilteredFiles,
		{
			mode,
			offline: options?.offline,
			timezone: options?.timezone,
			singleThread: options?.singleThread,
		},
	);
	if (workerFileResults == null) {
		using fetcher = mode === 'display' ? null : new PricingFetcher(options?.offline);
		const calculateCost = await createCostCalculator(mode, fetcher);
		const fileResults = await mapWithConcurrency(
			mtimeFilteredFiles,
			getJSONLFileReadConcurrency(mtimeFilteredFiles.length, options?.singleThread),
			async (file): Promise<BlockFileResult> => collectBlockFileResult(file, calculateCost),
		);
		fileResults.sort(compareBlockFileResults);
		for (const { entries } of fileResults) {
			for (const entry of entries) {
				mergeBlockEntry(entry);
			}
		}
	} else {
		workerFileResults.sort(compareBlockFileResults);
		for (const encodedResult of workerFileResults) {
			forEachBlockEntry(encodedResult, mergeBlockEntry);
		}
	}

	// Identify session blocks
	const blocks = identifySessionBlocks(allEntries, options?.sessionDurationHours);

	// Filter by date range if specified
	const dateFiltered =
		(options?.since != null && options.since !== '') ||
		(options?.until != null && options.until !== '')
			? blocks.filter((block) => {
					const blockDateStr = formatUsageDate(block.startTime.toISOString()).replace(/-/g, '');
					if (options.since != null && options.since !== '' && blockDateStr < options.since) {
						return false;
					}
					if (options.until != null && options.until !== '' && blockDateStr > options.until) {
						return false;
					}
					return true;
				})
			: blocks;

	// Sort by start time based on order option
	return sortByDate(dateFiltered, (block) => block.startTime, options?.order);
}

async function runUsageWorker(data: UsageWorkerData): Promise<void> {
	using fetcher = data.mode === 'display' ? null : new PricingFetcher(data.offline);
	const calculateCost = await createCostCalculator(data.mode, fetcher, data.pricing);
	const formatUsageDate = createCachedDateFormatter(data.timezone);

	switch (data.task) {
		case 'daily': {
			const results = [];
			const transferList: ArrayBuffer[] = [];
			for (const { index, item } of data.items as Array<IndexedWorkerItem<string>>) {
				const result = encodeDailyDataEntries(
					await collectDailyEntriesFromFile(item, calculateCost, formatUsageDate),
				);
				transferList.push(result.numbers.buffer as ArrayBuffer, result.flags.buffer as ArrayBuffer);
				results.push({
					index,
					result,
				});
			}
			parentPort!.postMessage(
				{ results } satisfies UsageWorkerResponse<EncodedDailyDataEntries>,
				transferList,
			);
			return;
		}
		case 'session': {
			const results = [];
			const transferList: ArrayBuffer[] = [];
			for (const { index, item } of data.items as Array<IndexedWorkerItem<GlobResult>>) {
				const result = encodeSessionDataEntries(
					await collectSessionEntriesFromFile(item, data.mode, calculateCost),
				);
				transferList.push(result.numbers.buffer as ArrayBuffer, result.flags.buffer as ArrayBuffer);
				results.push({
					index,
					result,
				});
			}
			parentPort!.postMessage(
				{ results } satisfies UsageWorkerResponse<EncodedSessionDataEntries>,
				transferList,
			);
			return;
		}
		case 'blocks': {
			const results = [];
			const transferList: ArrayBuffer[] = [];
			for (const { index, item } of data.items as Array<IndexedWorkerItem<string>>) {
				const result = encodeBlockFileResult(await collectBlockFileResult(item, calculateCost));
				transferList.push(result.numbers.buffer as ArrayBuffer, result.flags.buffer as ArrayBuffer);
				results.push({
					index,
					result,
				});
			}
			parentPort!.postMessage(
				{ results } satisfies UsageWorkerResponse<EncodedBlockFileResult>,
				transferList,
			);
			return;
		}
		default:
			unreachable(data.task);
	}
}

if (!isMainThread && isRecord(workerData) && workerData.kind === 'ccusage:usage-worker') {
	void runUsageWorker(workerData as UsageWorkerData).catch(() => {
		process.exit(1);
	});
}

if (import.meta.vitest != null) {
	describe('fast JSONL parser helpers', () => {
		it('parses token counters after fixed markers', () => {
			const line = '{"usage":{"input_tokens":12345,"output_tokens":678}}';

			expect(extractUnsignedIntegerMarker(line, INPUT_TOKENS_MARKER)).toBe(12345);
			expect(extractUnsignedIntegerMarker(line, OUTPUT_TOKENS_MARKER)).toBe(678);
			expect(extractUnsignedIntegerMarker(line, CACHE_READ_INPUT_TOKENS_MARKER)).toBeUndefined();
			expect(
				extractUnsignedIntegerMarker('{"input_tokens":-1}', INPUT_TOKENS_MARKER),
			).toBeUndefined();
		});

		it('parses JSON number cost values after fixed markers', () => {
			expect(extractJsonNumberMarker('{"costUSD":12}', COST_USD_MARKER)).toBe(12);
			expect(extractJsonNumberMarker('{"costUSD":-0.125}', COST_USD_MARKER)).toBe(-0.125);
			expect(extractJsonNumberMarker('{"costUSD":1.25e-3}', COST_USD_MARKER)).toBe(0.00125);
			expect(extractJsonNumberMarker('{"costUSD":1e+2}', COST_USD_MARKER)).toBe(100);
			expect(extractJsonNumberMarker('{"costUSD":null}', COST_USD_MARKER)).toBeUndefined();
		});

		it('detects only null fields that change fast parser semantics', () => {
			expect(hasUnsupportedNullField('{"message":{"content":null}}')).toBe(false);
			expect(hasUnsupportedNullField('{"message":{"model":null}}')).toBe(true);
			expect(hasUnsupportedNullField('{"message":{"usage":{"speed":null}}}')).toBe(true);
			expect(hasUnsupportedNullField('{"requestId":null}')).toBe(true);
		});
	});

	describe('formatDate', () => {
		it('formats UTC timestamp to local date', () => {
			// Test with UTC timestamps - results depend on local timezone
			expect(formatDate('2024-01-01T00:00:00Z')).toBe('2024-01-01');
			expect(formatDate('2024-12-31T23:59:59Z')).toBe('2024-12-31');
		});

		it('respects timezone parameter', () => {
			// Test date that crosses day boundary
			const testTimestamp = '2024-01-01T15:00:00Z'; // 3 PM UTC = midnight JST next day

			// Default behavior (no timezone) uses system timezone
			expect(formatDate(testTimestamp)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

			// UTC timezone
			expect(formatDate(testTimestamp, 'UTC')).toBe('2024-01-01');

			// Asia/Tokyo timezone (crosses to next day)
			expect(formatDate(testTimestamp, 'Asia/Tokyo')).toBe('2024-01-02');

			// America/New_York timezone
			expect(formatDate('2024-01-02T03:00:00Z', 'America/New_York')).toBe('2024-01-01'); // 3 AM UTC = 10 PM EST previous day

			// Invalid timezone should throw a RangeError
			expect(() => formatDate(testTimestamp, 'Invalid/Timezone')).toThrow(RangeError);
		});

		it('handles various date formats', () => {
			expect(formatDate('2024-01-01')).toBe('2024-01-01');
			expect(formatDate('2024-01-01T12:00:00')).toBe('2024-01-01');
			expect(formatDate('2024-01-01T12:00:00.000Z')).toBe('2024-01-01');
		});

		it('pads single digit months and days', () => {
			// Use UTC noon to avoid timezone issues
			expect(formatDate('2024-01-05T12:00:00Z')).toBe('2024-01-05');
			expect(formatDate('2024-10-01T12:00:00Z')).toBe('2024-10-01');
		});
	});

	describe('loadSessionUsageById', async () => {
		const { createFixture } = await import('fs-fixture');

		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it('loads usage data for a specific session', async () => {
			await using fixture = await createFixture({
				'.claude': {
					projects: {
						'test-project': {
							'session-123.jsonl': `${JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								sessionId: 'session-123',
								message: {
									usage: {
										input_tokens: 100,
										output_tokens: 50,
										cache_creation_input_tokens: 10,
										cache_read_input_tokens: 20,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.5,
							})}\n${JSON.stringify({
								timestamp: '2024-01-01T01:00:00Z',
								sessionId: 'session-123',
								message: {
									usage: {
										input_tokens: 200,
										output_tokens: 100,
										cache_creation_input_tokens: 20,
										cache_read_input_tokens: 40,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 1.0,
							})}`,
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.getPath('.claude'));

			const result = await loadSessionUsageById('session-123', { mode: 'display' });

			expect(result).not.toBeNull();
			expect(result?.totalCost).toBe(1.5);
			expect(result?.entries).toHaveLength(2);
		});

		it('returns null for non-existent session', async () => {
			await using fixture = await createFixture({
				'.claude': {
					projects: {
						'test-project': {
							'other-session.jsonl': JSON.stringify({
								timestamp: '2024-01-01T00:00:00Z',
								sessionId: 'other-session',
								message: {
									usage: {
										input_tokens: 100,
										output_tokens: 50,
									},
									model: 'claude-sonnet-4-20250514',
								},
								costUSD: 0.5,
							}),
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', fixture.getPath('.claude'));

			const result = await loadSessionUsageById('non-existent', { mode: 'display' });

			expect(result).toBeNull();
		});
	});

	describe('getDisplayModelName', () => {
		it('sums all token fields used for dedupe preference', () => {
			expect(
				sumUsageTokens({
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 25,
					cache_read_input_tokens: 10,
				}),
			).toBe(185);
		});

		it('returns model name as-is for standard speed', () => {
			const data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
				message: {
					usage: { input_tokens: 100, output_tokens: 50, speed: 'standard' },
					model: createModelName('claude-opus-4-6'),
				},
			};
			expect(getDisplayModelName(data)).toBe('claude-opus-4-6');
		});

		it('appends (fast) suffix for fast speed', () => {
			const data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
				message: {
					usage: { input_tokens: 100, output_tokens: 50, speed: 'fast' },
					model: createModelName('claude-opus-4-6'),
				},
			};
			expect(getDisplayModelName(data)).toBe('claude-opus-4-6-fast');
		});

		it('returns model name as-is when speed is undefined', () => {
			const data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
				message: {
					usage: { input_tokens: 100, output_tokens: 50 },
					model: createModelName('claude-opus-4-6'),
				},
			};
			expect(getDisplayModelName(data)).toBe('claude-opus-4-6');
		});

		it('returns undefined when model is undefined', () => {
			const data: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
				message: {
					usage: { input_tokens: 100, output_tokens: 50, speed: 'fast' },
				},
			};
			expect(getDisplayModelName(data)).toBeUndefined();
		});
	});

	describe('summarizeUsageEntries', () => {
		it('aggregates totals, models, and model breakdowns in one result', () => {
			const sonnet: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 25,
						cache_read_input_tokens: 10,
					},
					model: createModelName('claude-sonnet-4-20250514'),
				},
			};
			const fastSonnet: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T11:00:00Z'),
				message: {
					usage: {
						input_tokens: 200,
						output_tokens: 75,
						cache_creation_input_tokens: 5,
						cache_read_input_tokens: 15,
						speed: 'fast',
					},
					model: createModelName('claude-sonnet-4-20250514'),
				},
			};
			const synthetic: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
				message: {
					usage: {
						input_tokens: 300,
						output_tokens: 125,
					},
					model: createModelName('<synthetic>'),
				},
			};

			const result = summarizeUsageEntries(
				[
					{ data: sonnet, cost: 0.01, model: getDisplayModelName(sonnet) },
					{ data: fastSonnet, cost: 0.02, model: getDisplayModelName(fastSonnet) },
					{ data: synthetic, cost: 0.03, model: getDisplayModelName(synthetic) },
				],
				(entry) => entry.model,
				(entry) => entry.data.message.usage,
				(entry) => entry.cost,
			);

			expect(result.inputTokens).toBe(600);
			expect(result.outputTokens).toBe(250);
			expect(result.cacheCreationTokens).toBe(30);
			expect(result.cacheReadTokens).toBe(25);
			expect(result.totalCost).toBe(0.06);
			expect(result.modelsUsed).toEqual([
				'claude-sonnet-4-20250514',
				'claude-sonnet-4-20250514-fast',
			]);
			expect(result.modelBreakdowns).toEqual([
				{
					modelName: 'claude-sonnet-4-20250514-fast',
					inputTokens: 200,
					outputTokens: 75,
					cacheCreationTokens: 5,
					cacheReadTokens: 15,
					cost: 0.02,
				},
				{
					modelName: 'claude-sonnet-4-20250514',
					inputTokens: 100,
					outputTokens: 50,
					cacheCreationTokens: 25,
					cacheReadTokens: 10,
					cost: 0.01,
				},
			]);
		});

		it('keeps unknown breakdowns out of modelsUsed unless the model name is explicit', () => {
			const unknownModelUsage = {
				input_tokens: 10,
				output_tokens: 5,
			};
			const explicitUnknownModelUsage = {
				input_tokens: 20,
				output_tokens: 10,
			};

			const result = summarizeUsageEntries(
				[
					{ cost: 0.01, model: undefined, usage: unknownModelUsage },
					{ cost: 0.02, model: 'unknown', usage: explicitUnknownModelUsage },
				],
				(entry) => entry.model,
				(entry) => entry.usage,
				(entry) => entry.cost,
			);

			expect(result.modelsUsed).toEqual(['unknown']);
			expect(result.modelBreakdowns).toEqual([
				{
					modelName: 'unknown',
					inputTokens: 30,
					outputTokens: 15,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					cost: 0.03,
				},
			]);
		});
	});

	describe('loadDailyUsageData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('aggregates daily usage data correctly', async () => {
			// Use timestamps in the middle of the day to avoid timezone issues
			const mockData1: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			const mockData2: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T18:00:00Z'),
				message: { usage: { input_tokens: 300, output_tokens: 150 } },
				costUSD: 0.03,
			};

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': mockData1.map((d) => JSON.stringify(d)).join('\n'),
						},
						session2: {
							'file2.jsonl': JSON.stringify(mockData2),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.date).toBe('2024-01-01');
			expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(result[0]?.outputTokens).toBe(300); // 50 + 100 + 150
			expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
		});

		it('handles cache tokens', async () => {
			const mockData: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
				message: {
					usage: {
						input_tokens: 100,
						output_tokens: 50,
						cache_creation_input_tokens: 25,
						cache_read_input_tokens: 10,
					},
				},
				costUSD: 0.01,
			};

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': JSON.stringify(mockData),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result[0]?.cacheCreationTokens).toBe(25);
			expect(result[0]?.cacheReadTokens).toBe(10);
		});

		it('filters by date range', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240125',
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.date).toBe('2024-01-15');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('sorts by date descending by default', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result[0]?.date).toBe('2024-01-31');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-01');
		});

		it("sorts by date ascending when order is 'asc'", async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});

			expect(result).toHaveLength(3);
			expect(result[0]?.date).toBe('2024-01-01');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-31');
		});

		it("sorts by date descending when order is 'desc'", async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadDailyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});

			expect(result).toHaveLength(3);
			expect(result[0]?.date).toBe('2024-01-31');
			expect(result[1]?.date).toBe('2024-01-15');
			expect(result[2]?.date).toBe('2024-01-01');
		});

		it('handles invalid JSON lines gracefully', async () => {
			const mockData = `
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
invalid json line
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":200,"output_tokens":100}},"costUSD":0.02}
{ broken json
{"timestamp":"2024-01-01T18:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			// Should only process valid lines
			expect(result).toHaveLength(1);
			expect(result[0]?.inputTokens).toBe(600); // 100 + 200 + 300
			expect(result[0]?.totalCost).toBe(0.06); // 0.01 + 0.02 + 0.03
		});

		it('skips data without required fields', async () => {
			const mockData = `
{"timestamp":"2024-01-01T12:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50}},"costUSD":0.01}
{"timestamp":"2024-01-01T14:00:00Z","message":{"usage":{}}}
{"timestamp":"2024-01-01T18:00:00Z","message":{}}
{"timestamp":"2024-01-01T20:00:00Z"}
{"message":{"usage":{"input_tokens":200,"output_tokens":100}}}
{"timestamp":"2024-01-01T22:00:00Z","message":{"usage":{"input_tokens":300,"output_tokens":150}},"costUSD":0.03}
`.trim();

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			// Should only include valid entries
			expect(result).toHaveLength(1);
			expect(result[0]?.inputTokens).toBe(400); // 100 + 300
			expect(result[0]?.totalCost).toBe(0.04); // 0.01 + 0.03
		});
	});

	describe('loadMonthlyUsageData', () => {
		it('aggregates daily data by month correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			// Should be sorted by month descending (2024-02 first)
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				month: '2024-02',
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.015,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 150,
						outputTokens: 75,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.015,
					},
				],
			});
			expect(result[1]).toEqual({
				month: '2024-01',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 300,
						outputTokens: 150,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.03,
					},
				],
			});
		});

		it('handles empty data', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('handles single month data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				month: '2024-01',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 300,
						outputTokens: 150,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.03,
					},
				],
			});
		});

		it('sorts months in descending order', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });
			const months = result.map((r) => r.month);

			expect(months).toEqual(['2024-03', '2024-02', '2024-01', '2023-12']);
		});

		it("sorts months in ascending order when order is 'asc'", async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const months = result.map((r) => r.month);

			expect(months).toEqual(['2023-12', '2024-01', '2024-02', '2024-03']);
		});

		it('handles year boundaries correctly in sorting', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-11-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			// Descending order (default)
			const descResult = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});
			const descMonths = descResult.map((r) => r.month);
			expect(descMonths).toEqual(['2024-02', '2024-01', '2023-12', '2023-11']);

			// Ascending order
			const ascResult = await loadMonthlyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const ascMonths = ascResult.map((r) => r.month);
			expect(ascMonths).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
		});

		it('respects date filters', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-15T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-03-01T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240225',
			});

			// Should only include February data
			expect(result).toHaveLength(1);
			expect(result[0]?.month).toBe('2024-02');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('handles cache tokens correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 25,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 50,
							cache_read_input_tokens: 20,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadMonthlyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.cacheCreationTokens).toBe(75); // 25 + 50
			expect(result[0]?.cacheReadTokens).toBe(30); // 10 + 20
		});
	});

	describe('loadWeeklyUsageData', () => {
		it('aggregates daily data by week correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			// Should be sorted by week descending (2024-01-15 first)
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				week: '2024-01-14',
				inputTokens: 150,
				outputTokens: 75,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.015,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 150,
						outputTokens: 75,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.015,
					},
				],
			});
			expect(result[1]).toEqual({
				week: '2023-12-31',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 300,
						outputTokens: 150,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.03,
					},
				],
			});
		});

		it('handles empty data', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('handles single week data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-03T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]).toEqual({
				week: '2023-12-31',
				inputTokens: 300,
				outputTokens: 150,
				cacheCreationTokens: 0,
				cacheReadTokens: 0,
				totalCost: 0.03,
				modelsUsed: [],
				modelBreakdowns: [
					{
						modelName: 'unknown',
						inputTokens: 300,
						outputTokens: 150,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						cost: 0.03,
					},
				],
			});
		});

		it('sorts weeks in descending order', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-08T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-22T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });
			const weeks = result.map((r) => r.week);

			expect(weeks).toEqual(['2024-01-21', '2024-01-14', '2024-01-07', '2023-12-31']);
		});

		it("sorts weeks in ascending order when order is 'asc'", async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-08T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-22T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path, order: 'asc' });
			const weeks = result.map((r) => r.week);

			expect(weeks).toEqual(['2023-12-31', '2024-01-07', '2024-01-14', '2024-01-21']);
		});

		it('handles year boundaries correctly in sorting', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-12-04T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-05T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2023-11-06T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			// Descending order (default)
			const descResult = await loadWeeklyUsageData({
				claudePath: fixture.path,
				order: 'desc',
			});
			const descWeeks = descResult.map((r) => r.week);
			expect(descWeeks).toEqual(['2024-02-04', '2023-12-31', '2023-12-03', '2023-11-05']);

			// Ascending order
			const ascResult = await loadWeeklyUsageData({
				claudePath: fixture.path,
				order: 'asc',
			});
			const ascWeeks = ascResult.map((r) => r.week);
			expect(ascWeeks).toEqual(['2023-11-05', '2023-12-03', '2023-12-31', '2024-02-04']);
		});

		it('respects date filters', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-02-06T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-03-05T12:00:00Z'),
					message: { usage: { input_tokens: 150, output_tokens: 75 } },
					costUSD: 0.015,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240225',
			});

			// Should only include February data
			expect(result).toHaveLength(1);
			expect(result[0]?.week).toBe('2024-02-04');
			expect(result[0]?.inputTokens).toBe(200);
		});

		it('handles cache tokens correctly', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-02T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 25,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-03T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 50,
							cache_read_input_tokens: 20,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadWeeklyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.cacheCreationTokens).toBe(75); // 25 + 50
			expect(result[0]?.cacheReadTokens).toBe(30); // 10 + 20
		});
	});

	describe('loadSessionData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			const result = await loadSessionData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('extracts session info from file paths', async () => {
			const mockData: UsageData = {
				timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
				message: { usage: { input_tokens: 100, output_tokens: 50 } },
				costUSD: 0.01,
			};

			await using fixture = await createFixture({
				projects: {
					'project1/subfolder': {
						session123: {
							'chat.jsonl': JSON.stringify(mockData),
						},
					},
					project2: {
						session456: {
							'chat.jsonl': JSON.stringify(mockData),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			expect(result).toHaveLength(2);
			expect(result.find((s) => s.sessionId === 'session123')).toBeTruthy();
			expect(result.find((s) => s.projectPath === path.join('project1', 'subfolder'))).toBeTruthy();
			expect(result.find((s) => s.sessionId === 'session456')).toBeTruthy();
			expect(result.find((s) => s.projectPath === 'project2')).toBeTruthy();
		});

		it('aggregates session usage data', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
							cache_creation_input_tokens: 10,
							cache_read_input_tokens: 5,
						},
					},
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: {
						usage: {
							input_tokens: 200,
							output_tokens: 100,
							cache_creation_input_tokens: 20,
							cache_read_input_tokens: 10,
						},
					},
					costUSD: 0.02,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'chat.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			const session = result[0];
			expect(session?.sessionId).toBe('session1');
			expect(session?.projectPath).toBe('project1');
			expect(session?.inputTokens).toBe(300); // 100 + 200
			expect(session?.outputTokens).toBe(150); // 50 + 100
			expect(session?.cacheCreationTokens).toBe(30); // 10 + 20
			expect(session?.cacheReadTokens).toBe(15); // 5 + 10
			expect(session?.totalCost).toBe(0.03); // 0.01 + 0.02
			expect(session?.lastActivity).toBe('2024-01-01');
		});

		it('tracks versions', async () => {
			const mockData: UsageData[] = [
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					version: createVersion('1.0.0'),
					costUSD: 0.01,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
					message: { usage: { input_tokens: 200, output_tokens: 100 } },
					version: createVersion('1.1.0'),
					costUSD: 0.02,
				},
				{
					timestamp: createISOTimestamp('2024-01-01T18:00:00Z'),
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					version: createVersion('1.0.0'), // Duplicate version
					costUSD: 0.03,
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'chat.jsonl': mockData.map((d) => JSON.stringify(d)).join('\n'),
						},
					},
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path });

			const session = result[0];
			expect(session?.versions).toEqual(['1.0.0', '1.1.0']); // Sorted and unique
		});

		it('sorts by cost descending by default', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.05,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.1,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map((s) => [s.sessionId, { 'chat.jsonl': JSON.stringify(s.data) }]),
					),
				},
			});

			const result = await loadSessionData({ claudePath: fixture.path, mode: 'display' });

			expect(result[0]?.sessionId).toBe('session3'); // highest cost
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session2'); // lowest cost
		});

		it("sorts by cost ascending when order is 'asc'", async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.05,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.1,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map((s) => [s.sessionId, { 'chat.jsonl': JSON.stringify(s.data) }]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				order: 'asc',
				mode: 'display',
			});

			expect(result[0]?.sessionId).toBe('session2'); // lowest cost first
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session3'); // highest cost last
		});

		it("sorts by cost descending when order is 'desc'", async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.05,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.1,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map((s) => [s.sessionId, { 'chat.jsonl': JSON.stringify(s.data) }]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				order: 'desc',
				mode: 'display',
			});

			expect(result[0]?.sessionId).toBe('session3'); // highest cost (same as default)
			expect(result[1]?.sessionId).toBe('session1');
			expect(result[2]?.sessionId).toBe('session2'); // lowest cost
		});

		it('filters by date range based on last activity', async () => {
			const sessions = [
				{
					sessionId: 'session1',
					data: {
						timestamp: createISOTimestamp('2024-01-01T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session2',
					data: {
						timestamp: createISOTimestamp('2024-01-15T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
				{
					sessionId: 'session3',
					data: {
						timestamp: createISOTimestamp('2024-01-31T12:00:00Z'),
						message: { usage: { input_tokens: 100, output_tokens: 50 } },
						costUSD: 0.01,
					},
				},
			];

			await using fixture = await createFixture({
				projects: {
					project1: Object.fromEntries(
						sessions.map((s) => [s.sessionId, { 'chat.jsonl': JSON.stringify(s.data) }]),
					),
				},
			});

			const result = await loadSessionData({
				claudePath: fixture.path,
				since: '20240110',
				until: '20240125',
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.lastActivity).toBe('2024-01-15');
		});
	});

	describe('loadDailyUsageData with fast mode', () => {
		it('should separate fast and standard entries into different model breakdowns', async () => {
			const standardEntry = JSON.stringify({
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 100, output_tokens: 50, speed: 'standard' },
					model: 'claude-opus-4-6',
				},
				costUSD: 0.01,
			});
			const fastEntry = JSON.stringify({
				timestamp: '2024-01-01T12:00:00Z',
				message: {
					usage: { input_tokens: 200, output_tokens: 100, speed: 'fast' },
					model: 'claude-opus-4-6',
				},
				costUSD: 0.05,
			});

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': `${standardEntry}\n${fastEntry}`,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.modelBreakdowns).toHaveLength(2);

			const standardBreakdown = result[0]?.modelBreakdowns.find(
				(b) => b.modelName === 'claude-opus-4-6',
			);
			const fastBreakdown = result[0]?.modelBreakdowns.find(
				(b) => b.modelName === 'claude-opus-4-6-fast',
			);

			expect(standardBreakdown).toBeDefined();
			expect(fastBreakdown).toBeDefined();
			expect(standardBreakdown?.inputTokens).toBe(100);
			expect(fastBreakdown?.inputTokens).toBe(200);
		});

		it('should treat entries without speed field as standard', async () => {
			const noSpeedEntry = JSON.stringify({
				timestamp: '2024-01-01T10:00:00Z',
				message: {
					usage: { input_tokens: 100, output_tokens: 50 },
					model: 'claude-opus-4-6',
				},
				costUSD: 0.01,
			});

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'file1.jsonl': noSpeedEntry,
						},
					},
				},
			});

			const result = await loadDailyUsageData({ claudePath: fixture.path });

			expect(result).toHaveLength(1);
			expect(result[0]?.modelBreakdowns).toHaveLength(1);
			expect(result[0]?.modelBreakdowns[0]?.modelName).toBe('claude-opus-4-6');
		});
	});

	describe('data-loader cost calculation with real pricing', () => {
		describe('loadDailyUsageData with mixed schemas', () => {
			it('should handle old schema with costUSD', async () => {
				const oldData = {
					timestamp: '2024-01-15T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
					},
					costUSD: 0.05, // Pre-calculated cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-old': {
							'session-old': {
								'usage.jsonl': `${JSON.stringify(oldData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-15');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('should calculate cost for new schema with claude-sonnet-4-20250514', async () => {
				// Use a well-known Claude model
				const modelName = createModelName('claude-sonnet-4-20250514');

				const newData = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 200,
							cache_read_input_tokens: 300,
						},
						model: modelName,
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-new': {
							'session-new': {
								'usage.jsonl': `${JSON.stringify(newData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-16');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(200);
				expect(results[0]?.cacheReadTokens).toBe(300);

				// Should have calculated some cost
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should calculate cost for new schema with claude-opus-4-20250514', async () => {
				// Use Claude 4 Opus model
				const modelName = createModelName('claude-opus-4-20250514');

				const newData = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 200,
							cache_read_input_tokens: 300,
						},
						model: modelName,
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-opus': {
							'session-opus': {
								'usage.jsonl': `${JSON.stringify(newData)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-16');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(200);
				expect(results[0]?.cacheReadTokens).toBe(300);

				// Should have calculated some cost
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should handle mixed data in same file', async () => {
				const data1 = {
					timestamp: '2024-01-17T10:00:00Z',
					message: { usage: { input_tokens: 100, output_tokens: 50 } },
					costUSD: 0.01,
				};

				const data2 = {
					timestamp: '2024-01-17T11:00:00Z',
					message: {
						usage: { input_tokens: 200, output_tokens: 100 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				const data3 = {
					timestamp: '2024-01-17T12:00:00Z',
					message: { usage: { input_tokens: 300, output_tokens: 150 } },
					// No costUSD and no model - should be 0 cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-mixed': {
							'session-mixed': {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n${JSON.stringify(data3)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-17');
				expect(results[0]?.inputTokens).toBe(600); // 100 + 200 + 300
				expect(results[0]?.outputTokens).toBe(300); // 50 + 100 + 150

				// Total cost should be at least the pre-calculated cost from data1
				expect(results[0]?.totalCost).toBeGreaterThanOrEqual(0.01);
			});

			it('should handle data without model or costUSD', async () => {
				const data = {
					timestamp: '2024-01-18T10:00:00Z',
					message: { usage: { input_tokens: 500, output_tokens: 250 } },
					// No costUSD and no model
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-no-cost': {
							'session-no-cost': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.inputTokens).toBe(500);
				expect(results[0]?.outputTokens).toBe(250);
				expect(results[0]?.totalCost).toBe(0); // 0 cost when no pricing info available
			});
		});

		describe('loadSessionData with mixed schemas', () => {
			it('should handle mixed cost sources in different sessions', async () => {
				const session1Data = {
					timestamp: '2024-01-15T10:00:00Z',
					message: { usage: { input_tokens: 1000, output_tokens: 500 } },
					costUSD: 0.05,
				};

				const session2Data = {
					timestamp: '2024-01-16T10:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session1: {
								'usage.jsonl': JSON.stringify(session1Data),
							},
							session2: {
								'usage.jsonl': JSON.stringify(session2Data),
							},
						},
					},
				});

				const results = await loadSessionData({ claudePath: fixture.path });

				expect(results).toHaveLength(2);

				// Check session 1
				const session1 = results.find((s) => s.sessionId === 'session1');
				expect(session1).toBeTruthy();
				expect(session1?.totalCost).toBe(0.05);

				// Check session 2
				const session2 = results.find((s) => s.sessionId === 'session2');
				expect(session2).toBeTruthy();
				expect(session2?.totalCost).toBeGreaterThan(0);
			});

			it('should handle unknown models gracefully', async () => {
				const data = {
					timestamp: '2024-01-19T10:00:00Z',
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: 'unknown-model-xyz',
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-unknown': {
							'session-unknown': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadSessionData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.totalCost).toBe(0); // 0 cost for unknown model
			});
		});

		describe('cached tokens cost calculation', () => {
			it('should correctly calculate costs for all token types with claude-sonnet-4-20250514', async () => {
				const data = {
					timestamp: '2024-01-20T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 2000,
							cache_read_input_tokens: 1500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-cache': {
							'session-cache': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-20');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(2000);
				expect(results[0]?.cacheReadTokens).toBe(1500);

				// Should have calculated cost including cache tokens
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('should correctly calculate costs for all token types with claude-opus-4-20250514', async () => {
				const data = {
					timestamp: '2024-01-20T10:00:00Z',
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
							cache_creation_input_tokens: 2000,
							cache_read_input_tokens: 1500,
						},
						model: createModelName('claude-opus-4-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project-opus-cache': {
							'session-opus-cache': {
								'usage.jsonl': `${JSON.stringify(data)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({ claudePath: fixture.path });

				expect(results).toHaveLength(1);
				expect(results[0]?.date).toBe('2024-01-20');
				expect(results[0]?.inputTokens).toBe(1000);
				expect(results[0]?.outputTokens).toBe(500);
				expect(results[0]?.cacheCreationTokens).toBe(2000);
				expect(results[0]?.cacheReadTokens).toBe(1500);

				// Should have calculated cost including cache tokens
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});
		});

		describe('cost mode functionality', () => {
			it('auto mode: uses costUSD when available, calculates otherwise', async () => {
				const data1 = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: { usage: { input_tokens: 1000, output_tokens: 500 } },
					costUSD: 0.05,
				};

				const data2 = {
					timestamp: '2024-01-01T11:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'auto',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0.05); // Should include both costs
			});

			it('calculate mode: always calculates from tokens, ignores costUSD', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 99.99, // This should be ignored
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'calculate',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
				expect(results[0]?.totalCost).toBeLessThan(1); // Much less than 99.99
			});

			it('display mode: always uses costUSD, even if undefined', async () => {
				const data1 = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				const data2 = {
					timestamp: '2024-01-01T11:00:00Z',
					message: {
						usage: { input_tokens: 2000, output_tokens: 1000 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					// No costUSD - should result in 0 cost
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': `${JSON.stringify(data1)}\n${JSON.stringify(data2)}\n`,
							},
						},
					},
				});

				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05); // Only the costUSD from data1
			});

			it('mode works with session data', async () => {
				const sessionData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 99.99,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session1: {
								'usage.jsonl': JSON.stringify(sessionData),
							},
						},
					},
				});

				// Test calculate mode
				const calculateResults = await loadSessionData({
					claudePath: fixture.path,
					mode: 'calculate',
				});
				expect(calculateResults[0]?.totalCost).toBeLessThan(1);

				// Test display mode
				const displayResults = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});
				expect(displayResults[0]?.totalCost).toBe(99.99);
			});
		});

		describe('pricing data fetching optimization', () => {
			it('should not require model pricing when mode is display', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// In display mode, only pre-calculated costUSD should be used
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('should fetch pricing data when mode is calculate', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This should fetch pricing data (will call real fetch)
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'calculate',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
				expect(results[0]?.totalCost).not.toBe(0.05); // Should calculate, not use costUSD
			});

			it('should fetch pricing data when mode is auto', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					// No costUSD, so auto mode will need to calculate
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This should fetch pricing data (will call real fetch)
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'auto',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBeGreaterThan(0);
			});

			it('session data should not require model pricing when mode is display', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-4-sonnet-20250514'),
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// In display mode, only pre-calculated costUSD should be used
				const results = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});

			it('display mode should work without network access', async () => {
				const data = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: 'some-unknown-model',
					},
					costUSD: 0.05,
				};

				await using fixture = await createFixture({
					projects: {
						'test-project': {
							session: {
								'usage.jsonl': JSON.stringify(data),
							},
						},
					},
				});

				// This test verifies that display mode doesn't try to fetch pricing
				// by using an unknown model that would cause pricing lookup to fail
				// if it were attempted. Since we're in display mode, it should just
				// use the costUSD value.
				const results = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(results).toHaveLength(1);
				expect(results[0]?.totalCost).toBe(0.05);
			});
		});
	});

	describe('calculateCostForEntry', () => {
		const mockUsageData: UsageData = {
			timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
			message: {
				usage: {
					input_tokens: 1000,
					output_tokens: 500,
					cache_creation_input_tokens: 200,
					cache_read_input_tokens: 100,
				},
				model: createModelName('claude-sonnet-4-20250514'),
			},
			costUSD: 0.05,
		};

		describe('display mode', () => {
			it('should return costUSD when available', async () => {
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
				expect(result).toBe(0.05);
			});

			it('should return 0 when costUSD is undefined', async () => {
				const dataWithoutCost = { ...mockUsageData };
				dataWithoutCost.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCost, 'display', fetcher);
				expect(result).toBe(0);
			});

			it('should not use model pricing in display mode', async () => {
				// Even with model pricing available, should use costUSD
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'display', fetcher);
				expect(result).toBe(0.05);
			});
		});

		describe('calculate mode', () => {
			it('should calculate cost from tokens when model pricing available', async () => {
				// Use the exact same structure as working integration tests
				const testData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(testData, 'calculate', fetcher);

				expect(result).toBeGreaterThan(0);
			});

			it('should ignore costUSD in calculate mode', async () => {
				using fetcher = new PricingFetcher();
				const dataWithHighCost = { ...mockUsageData, costUSD: 99.99 };
				const result = await calculateCostForEntry(dataWithHighCost, 'calculate', fetcher);

				expect(result).toBeGreaterThan(0);
				expect(result).toBeLessThan(1); // Much less than 99.99
			});

			it('should return 0 when model not available', async () => {
				const dataWithoutModel = { ...mockUsageData };
				dataWithoutModel.message.model = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutModel, 'calculate', fetcher);
				expect(result).toBe(0);
			});

			it('should return 0 when model pricing not found', async () => {
				const dataWithUnknownModel = {
					...mockUsageData,
					message: { ...mockUsageData.message, model: createModelName('unknown-model') },
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithUnknownModel, 'calculate', fetcher);
				expect(result).toBe(0);
			});

			it('should handle missing cache tokens', async () => {
				const dataWithoutCacheTokens: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCacheTokens, 'calculate', fetcher);

				expect(result).toBeGreaterThan(0);
			});
		});

		describe('auto mode', () => {
			it('should use costUSD when available', async () => {
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
				expect(result).toBe(0.05);
			});

			it('should calculate from tokens when costUSD undefined', async () => {
				const dataWithoutCost: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 1000,
							output_tokens: 500,
						},
						model: createModelName('claude-4-sonnet-20250514'),
					},
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCost, 'auto', fetcher);
				expect(result).toBeGreaterThan(0);
			});

			it('should return 0 when no costUSD and no model', async () => {
				const dataWithoutCostOrModel = { ...mockUsageData };
				dataWithoutCostOrModel.costUSD = undefined;
				dataWithoutCostOrModel.message.model = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCostOrModel, 'auto', fetcher);
				expect(result).toBe(0);
			});

			it('should return 0 when no costUSD and model pricing not found', async () => {
				const dataWithoutCost = { ...mockUsageData };
				dataWithoutCost.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithoutCost, 'auto', fetcher);
				expect(result).toBe(0);
			});

			it('should prefer costUSD over calculation even when both available', async () => {
				// Both costUSD and model pricing available, should use costUSD
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(mockUsageData, 'auto', fetcher);
				expect(result).toBe(0.05);
			});
		});

		describe('edge cases', () => {
			it('should handle zero token counts', async () => {
				const dataWithZeroTokens = {
					...mockUsageData,
					message: {
						...mockUsageData.message,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
						},
					},
				};
				dataWithZeroTokens.costUSD = undefined;

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithZeroTokens, 'calculate', fetcher);
				expect(result).toBe(0);
			});

			it('should handle costUSD of 0', async () => {
				const dataWithZeroCost = { ...mockUsageData, costUSD: 0 };
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithZeroCost, 'display', fetcher);
				expect(result).toBe(0);
			});

			it('should handle negative costUSD', async () => {
				const dataWithNegativeCost = { ...mockUsageData, costUSD: -0.01 };
				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(dataWithNegativeCost, 'display', fetcher);
				expect(result).toBe(-0.01);
			});
		});

		describe('fast mode', () => {
			it('should apply fast multiplier in calculate mode', async () => {
				const standardData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: createModelName('claude-opus-4-6'),
					},
				};
				const fastData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500, speed: 'fast' },
						model: createModelName('claude-opus-4-6'),
					},
				};

				using fetcher = new PricingFetcher();
				const standardCost = await calculateCostForEntry(standardData, 'calculate', fetcher);
				const fastCost = await calculateCostForEntry(fastData, 'calculate', fetcher);

				expect(standardCost).toBeGreaterThan(0);
				expect(fastCost).toBeGreaterThan(standardCost);
				expect(fastCost).toBeCloseTo(standardCost * 6, 5);
			});

			it('should apply fast multiplier in auto mode when costUSD is absent', async () => {
				const fastData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500, speed: 'fast' },
						model: createModelName('claude-opus-4-6'),
					},
				};

				using fetcher = new PricingFetcher();
				const fastCost = await calculateCostForEntry(fastData, 'auto', fetcher);
				expect(fastCost).toBeGreaterThan(0);
			});

			it('should not apply fast multiplier in display mode', async () => {
				const fastData: UsageData = {
					timestamp: createISOTimestamp('2024-01-01T10:00:00Z'),
					message: {
						usage: { input_tokens: 1000, output_tokens: 500, speed: 'fast' },
						model: createModelName('claude-opus-4-6'),
					},
					costUSD: 0.05,
				};

				using fetcher = new PricingFetcher();
				const result = await calculateCostForEntry(fastData, 'display', fetcher);
				expect(result).toBe(0.05);
			});
		});

		describe('offline mode', () => {
			it('should pass offline flag through loadDailyUsageData', async () => {
				await using fixture = await createFixture({ projects: {} });
				// This test verifies that the offline flag is properly passed through
				// We can't easily mock the internal behavior, but we can verify it doesn't throw
				const result = await loadDailyUsageData({
					claudePath: fixture.path,
					offline: true,
					mode: 'calculate',
				});

				// Should return empty array or valid data without throwing
				expect(Array.isArray(result)).toBe(true);
			});
		});
	});

	describe('loadSessionBlockData', () => {
		it('returns empty array when no files found', async () => {
			await using fixture = await createFixture({ projects: {} });
			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toEqual([]);
		});

		it('loads and identifies five-hour blocks correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');
			const laterTime = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour later
			const muchLaterTime = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hours later

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: {
											input_tokens: 1000,
											output_tokens: 500,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: laterTime.toISOString(),
									message: {
										id: 'msg2',
										usage: {
											input_tokens: 2000,
											output_tokens: 1000,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: muchLaterTime.toISOString(),
									message: {
										id: 'msg3',
										usage: {
											input_tokens: 1500,
											output_tokens: 750,
										},
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req3',
									costUSD: 0.015,
									version: createVersion('1.0.0'),
								},
							]
								.map((data) => JSON.stringify(data))
								.join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result.length).toBeGreaterThan(0); // Should have blocks
			expect(result[0]?.entries).toHaveLength(1); // First block has one entry
			// Total entries across all blocks should be 3
			const totalEntries = result.reduce((sum, block) => sum + block.entries.length, 0);
			expect(totalEntries).toBe(3);
		});

		it('handles cost calculation modes correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': JSON.stringify({
								timestamp: now.toISOString(),
								message: {
									id: 'msg1',
									usage: {
										input_tokens: 1000,
										output_tokens: 500,
									},
									model: createModelName('claude-sonnet-4-20250514'),
								},
								request: { id: 'req1' },
								costUSD: 0.01,
								version: createVersion('1.0.0'),
							}),
						},
					},
				},
			});

			// Test display mode
			const displayResult = await loadSessionBlockData({
				claudePath: fixture.path,
				mode: 'display',
			});
			expect(displayResult).toHaveLength(1);
			expect(displayResult[0]?.costUSD).toBe(0.01);

			// Test calculate mode
			const calculateResult = await loadSessionBlockData({
				claudePath: fixture.path,
				mode: 'calculate',
			});
			expect(calculateResult).toHaveLength(1);
			expect(calculateResult[0]?.costUSD).toBeGreaterThan(0);
		});

		it('keeps the most complete duplicate usage entry', async () => {
			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'chat.jsonl': [
								JSON.stringify({
									timestamp: '2025-01-10T10:00:00.000Z',
									message: {
										id: 'msg_123',
										model: 'claude-opus-4-6',
										usage: {
											input_tokens: 100,
											output_tokens: 25,
											cache_creation_input_tokens: 10,
											cache_read_input_tokens: 5,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
								JSON.stringify({
									timestamp: '2025-01-10T10:00:01.000Z',
									message: {
										id: 'msg_123',
										model: 'claude-opus-4-6',
										usage: {
											input_tokens: 100,
											output_tokens: 250,
											cache_creation_input_tokens: 10,
											cache_read_input_tokens: 5,
											speed: 'standard',
										},
									},
									requestId: 'req_456',
									costUSD: 0.01,
								}),
							].join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({
				claudePath: fixture.path,
				mode: 'display',
			});

			const usageBlock = result.find((block) => block.isGap !== true);
			expect(usageBlock?.tokenCounts.inputTokens).toBe(100);
			expect(usageBlock?.tokenCounts.outputTokens).toBe(250);
			expect(usageBlock?.costUSD).toBe(0.01);
		});

		it('filters by date range correctly', async () => {
			const date1 = new Date('2024-01-01T10:00:00Z');
			const date2 = new Date('2024-01-02T10:00:00Z');
			const date3 = new Date('2024-01-03T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: date1.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date2.toISOString(),
									message: {
										id: 'msg2',
										usage: { input_tokens: 2000, output_tokens: 1000 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date3.toISOString(),
									message: {
										id: 'msg3',
										usage: { input_tokens: 1500, output_tokens: 750 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req3',
									costUSD: 0.015,
									version: createVersion('1.0.0'),
								},
							]
								.map((data) => JSON.stringify(data))
								.join('\n'),
						},
					},
				},
			});

			// Test filtering with since parameter
			const sinceResult = await loadSessionBlockData({
				claudePath: fixture.path,
				since: '20240102',
			});
			expect(sinceResult.length).toBeGreaterThan(0);
			expect(sinceResult.every((block) => block.startTime >= date2)).toBe(true);

			// Test filtering with until parameter
			const untilResult = await loadSessionBlockData({
				claudePath: fixture.path,
				until: '20240102',
			});
			expect(untilResult.length).toBeGreaterThan(0);
			// The filter uses formatDate which converts to YYYYMMDD format for comparison
			expect(
				untilResult.every((block) => {
					const blockDateStr = block.startTime.toISOString().slice(0, 10).replace(/-/g, '');
					return blockDateStr <= '20240102';
				}),
			).toBe(true);
		});

		it('sorts blocks by order parameter', async () => {
			const date1 = new Date('2024-01-01T10:00:00Z');
			const date2 = new Date('2024-01-02T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: date2.toISOString(),
									message: {
										id: 'msg2',
										usage: { input_tokens: 2000, output_tokens: 1000 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req2',
									costUSD: 0.02,
									version: createVersion('1.0.0'),
								},
								{
									timestamp: date1.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
							]
								.map((data) => JSON.stringify(data))
								.join('\n'),
						},
					},
				},
			});

			// Test ascending order
			const ascResult = await loadSessionBlockData({
				claudePath: fixture.path,
				order: 'asc',
			});
			expect(ascResult[0]?.startTime).toEqual(date1);

			// Test descending order
			const descResult = await loadSessionBlockData({
				claudePath: fixture.path,
				order: 'desc',
			});
			expect(descResult[0]?.startTime).toEqual(date2);
		});

		it('handles deduplication correctly', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
								// Duplicate entry - should be filtered out
								{
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								},
							]
								.map((data) => JSON.stringify(data))
								.join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toHaveLength(1);
			expect(result[0]?.entries).toHaveLength(1); // Only one entry after deduplication
		});

		it('handles invalid JSON lines gracefully', async () => {
			const now = new Date('2024-01-01T10:00:00Z');

			await using fixture = await createFixture({
				projects: {
					project1: {
						session1: {
							'conversation1.jsonl': [
								'invalid json line',
								JSON.stringify({
									timestamp: now.toISOString(),
									message: {
										id: 'msg1',
										usage: { input_tokens: 1000, output_tokens: 500 },
										model: createModelName('claude-sonnet-4-20250514'),
									},
									requestId: 'req1',
									costUSD: 0.01,
									version: createVersion('1.0.0'),
								}),
								'another invalid line',
							].join('\n'),
						},
					},
				},
			});

			const result = await loadSessionBlockData({ claudePath: fixture.path });
			expect(result).toHaveLength(1);
			expect(result[0]?.entries).toHaveLength(1);
		});

		describe('processJSONLFileByLine', () => {
			it('should process each non-empty line with correct line numbers', async () => {
				await using fixture = await createFixture({
					'test.jsonl': '{"line": 1}\n{"line": 2}\n{"line": 3}\n',
				});

				const lines: Array<{ content: string; lineNumber: number }> = [];
				await processJSONLFileByLine(path.join(fixture.path, 'test.jsonl'), (line, lineNumber) => {
					lines.push({ content: line, lineNumber });
				});

				expect(lines).toHaveLength(3);
				expect(lines[0]).toEqual({ content: '{"line": 1}', lineNumber: 1 });
				expect(lines[1]).toEqual({ content: '{"line": 2}', lineNumber: 2 });
				expect(lines[2]).toEqual({ content: '{"line": 3}', lineNumber: 3 });
			});

			it('should skip empty lines', async () => {
				await using fixture = await createFixture({
					'test.jsonl': '{"line": 1}\n\n{"line": 2}\n  \n{"line": 3}\n',
				});

				const lines: string[] = [];
				await processJSONLFileByLine(path.join(fixture.path, 'test.jsonl'), (line) => {
					lines.push(line);
				});

				expect(lines).toHaveLength(3);
				expect(lines[0]).toBe('{"line": 1}');
				expect(lines[1]).toBe('{"line": 2}');
				expect(lines[2]).toBe('{"line": 3}');
			});

			it('should handle async processLine callback', async () => {
				await using fixture = await createFixture({
					'test.jsonl': '{"line": 1}\n{"line": 2}\n',
				});

				const results: string[] = [];
				await processJSONLFileByLine(path.join(fixture.path, 'test.jsonl'), async (line) => {
					// Simulate async operation
					await new Promise((resolve) => setTimeout(resolve, 1));
					results.push(line);
				});

				expect(results).toHaveLength(2);
				expect(results[0]).toBe('{"line": 1}');
				expect(results[1]).toBe('{"line": 2}');
			});

			it('should throw error when file does not exist', async () => {
				await expect(processJSONLFileByLine('/nonexistent/file.jsonl', () => {})).rejects.toThrow();
			});

			it('should handle empty file', async () => {
				await using fixture = await createFixture({
					'empty.jsonl': '',
				});

				const lines: string[] = [];
				await processJSONLFileByLine(path.join(fixture.path, 'empty.jsonl'), (line) => {
					lines.push(line);
				});

				expect(lines).toHaveLength(0);
			});

			it('should handle file with only empty lines', async () => {
				await using fixture = await createFixture({
					'only-empty.jsonl': '\n\n  \n\t\n',
				});

				const lines: string[] = [];
				await processJSONLFileByLine(path.join(fixture.path, 'only-empty.jsonl'), (line) => {
					lines.push(line);
				});

				expect(lines).toHaveLength(0);
			});

			it('should process large files (600MB+) without RangeError', async () => {
				// Create a realistic JSONL entry similar to actual Claude data (~283 bytes per line)
				const sampleEntry = `${JSON.stringify({
					timestamp: '2025-01-10T10:00:00Z',
					message: {
						id: 'msg_01234567890123456789',
						usage: { input_tokens: 1000, output_tokens: 500 },
						model: 'claude-sonnet-4-20250514',
					},
					requestId: 'req_01234567890123456789',
					costUSD: 0.01,
				})}\n`;

				// Target 600MB file (this would cause RangeError with readFile in Node.js)
				const targetMB = 600;
				const lineSize = Buffer.byteLength(sampleEntry, 'utf-8');
				const lineCount = Math.ceil((targetMB * 1024 * 1024) / lineSize);

				// Create fixture directory first
				await using fixture = await createFixture({});
				const filePath = path.join(fixture.path, 'large.jsonl');

				// Write file using streaming to avoid Node.js string length limit (~512MB)
				// Creating a 600MB string directly would cause "RangeError: Invalid string length"
				const writeStream = createWriteStream(filePath);

				// Write lines and handle backpressure
				for (let i = 0; i < lineCount; i++) {
					const canContinue = writeStream.write(sampleEntry);
					// Respect backpressure by waiting for drain event
					if (!canContinue) {
						await new Promise<void>((resolve) => writeStream.once('drain', () => resolve()));
					}
				}

				// Ensure all data is flushed
				await new Promise<void>((resolve, reject) => {
					writeStream.end((err?: Error | null) => (err != null ? reject(err) : resolve()));
				});

				// Test streaming processing
				let processedCount = 0;
				await processJSONLFileByLine(filePath, () => {
					processedCount++;
				});

				expect(processedCount).toBe(lineCount);
			}, 30000);
		});
	});
}

// duplication functionality tests
if (import.meta.vitest != null) {
	describe('deduplication functionality', () => {
		describe('createUniqueHash', () => {
			it('should create hash from message id and request id', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						id: createMessageId('msg_123'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req_456'),
				};

				const hash = createUniqueHash(data);
				expect(hash).toBe('msg_123:req_456');
			});

			it('should return null when message id is missing', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
					requestId: createRequestId('req_456'),
				};

				const hash = createUniqueHash(data);
				expect(hash).toBeNull();
			});

			it('should return null when request id is missing', () => {
				const data = {
					timestamp: createISOTimestamp('2025-01-10T10:00:00Z'),
					message: {
						id: createMessageId('msg_123'),
						usage: {
							input_tokens: 100,
							output_tokens: 50,
						},
					},
				};

				const hash = createUniqueHash(data);
				expect(hash).toBeNull();
			});
		});

		describe('createDedupedEntryIndex', () => {
			it('stores exact string keys without inherited prototype collisions', () => {
				const index = createDedupedEntryIndex();
				const protoKey = '__proto__';

				index['msg_1:req_1'] = 1;
				index[protoKey] = 2;

				expect(index['msg_1:req_1']).toBe(1);
				expect(index[protoKey]).toBe(2);
				expect(Object.getPrototypeOf(index)).toBeNull();
			});
		});

		describe('getEarliestTimestamp', () => {
			it('should extract earliest timestamp from JSONL file', async () => {
				const content = [
					JSON.stringify({ timestamp: '2025-01-15T12:00:00Z', message: { usage: {} } }),
					JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
					JSON.stringify({ timestamp: '2025-01-12T11:00:00Z', message: { usage: {} } }),
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
			});

			it('should handle files without timestamps', async () => {
				const content = [
					JSON.stringify({ message: { usage: {} } }),
					JSON.stringify({ data: 'no timestamp' }),
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toBeNull();
			});

			it('should skip invalid JSON lines', async () => {
				const content = [
					'invalid json',
					JSON.stringify({ timestamp: '2025-01-10T10:00:00Z', message: { usage: {} } }),
					'{ broken: json',
				].join('\n');

				await using fixture = await createFixture({
					'test.jsonl': content,
				});

				const timestamp = await getEarliestTimestamp(fixture.getPath('test.jsonl'));
				expect(timestamp).toEqual(new Date('2025-01-10T10:00:00Z'));
			});
		});

		describe('sortFilesByTimestamp', () => {
			it('should sort files by earliest timestamp', async () => {
				await using fixture = await createFixture({
					'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
					'file2.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
					'file3.jsonl': JSON.stringify({ timestamp: '2025-01-12T10:00:00Z' }),
				});

				const file1 = fixture.getPath('file1.jsonl');
				const file2 = fixture.getPath('file2.jsonl');
				const file3 = fixture.getPath('file3.jsonl');

				const sorted = await sortFilesByTimestamp([file1, file2, file3]);

				expect(sorted).toEqual([file2, file3, file1]); // Chronological order
			});

			it('should place files without timestamps at the end', async () => {
				await using fixture = await createFixture({
					'file1.jsonl': JSON.stringify({ timestamp: '2025-01-15T10:00:00Z' }),
					'file2.jsonl': JSON.stringify({ no_timestamp: true }),
					'file3.jsonl': JSON.stringify({ timestamp: '2025-01-10T10:00:00Z' }),
				});

				const file1 = fixture.getPath('file1.jsonl');
				const file2 = fixture.getPath('file2.jsonl');
				const file3 = fixture.getPath('file3.jsonl');

				const sorted = await sortFilesByTimestamp([file1, file2, file3]);

				expect(sorted).toEqual([file3, file1, file2]); // file2 without timestamp goes to end
			});
		});

		describe('filterFilesByMtime', () => {
			it('should keep only files modified near or after since date', async () => {
				await using fixture = await createFixture({
					'old.jsonl': '',
					'recent.jsonl': '',
				});

				const oldFile = fixture.getPath('old.jsonl');
				const recentFile = fixture.getPath('recent.jsonl');
				await utimes(oldFile, new Date('2025-01-08T00:00:00Z'), new Date('2025-01-08T00:00:00Z'));
				await utimes(
					recentFile,
					new Date('2025-01-09T00:00:00Z'),
					new Date('2025-01-09T00:00:00Z'),
				);

				const filtered = await filterFilesByMtime(
					[oldFile, recentFile],
					(filePath) => filePath,
					'20250110',
				);

				expect(filtered).toEqual([recentFile]);
			});

			it('should leave files unchanged when since is invalid', async () => {
				await using fixture = await createFixture({
					'file1.jsonl': '',
					'file2.jsonl': '',
				});

				const files = [fixture.getPath('file1.jsonl'), fixture.getPath('file2.jsonl')];
				const filtered = await filterFilesByMtime(files, (filePath) => filePath, '20250231');

				expect(filtered).toEqual(files);
			});

			it('should use explicit minimum update time when provided', async () => {
				await using fixture = await createFixture({
					'old.jsonl': '',
					'recent.jsonl': '',
				});

				const oldFile = fixture.getPath('old.jsonl');
				const recentFile = fixture.getPath('recent.jsonl');
				await utimes(oldFile, new Date('2025-01-10T00:00:00Z'), new Date('2025-01-10T00:00:00Z'));
				await utimes(
					recentFile,
					new Date('2025-01-10T12:00:00Z'),
					new Date('2025-01-10T12:00:00Z'),
				);

				const filtered = await filterFilesByMtime(
					[oldFile, recentFile],
					(filePath) => filePath,
					undefined,
					new Date('2025-01-10T06:00:00Z'),
				);

				expect(filtered).toEqual([recentFile]);
			});
		});

		describe('loadDailyUsageData with deduplication', () => {
			it('should deduplicate entries with same message and request IDs', async () => {
				await using fixture = await createFixture({
					projects: {
						project1: {
							session1: {
								'file1.jsonl': JSON.stringify({
									timestamp: '2025-01-10T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
							session2: {
								'file2.jsonl': JSON.stringify({
									timestamp: '2025-01-15T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
						},
					},
				});

				const data = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(data).toHaveLength(1);
				expect(data[0]?.inputTokens).toBe(100);
				expect(data[0]?.outputTokens).toBe(50);
			});

			it('keeps the duplicate with more usage tokens across files', async () => {
				await using fixture = await createFixture({
					projects: {
						'newer.jsonl': JSON.stringify({
							timestamp: '2025-01-15T10:00:00Z',
							message: {
								id: 'msg_123',
								usage: {
									input_tokens: 200,
									output_tokens: 100,
								},
							},
							requestId: 'req_456',
							costUSD: 0.002,
						}),
						'older.jsonl': JSON.stringify({
							timestamp: '2025-01-10T10:00:00Z',
							message: {
								id: 'msg_123',
								usage: {
									input_tokens: 100,
									output_tokens: 50,
								},
							},
							requestId: 'req_456',
							costUSD: 0.001,
						}),
					},
				});

				const data = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(data).toHaveLength(1);
				expect(data[0]?.date).toBe('2025-01-15');
				expect(data[0]?.inputTokens).toBe(200);
				expect(data[0]?.outputTokens).toBe(100);
			});

			it('keeps the most complete duplicate usage entry', async () => {
				await using fixture = await createFixture({
					projects: {
						project1: {
							session1: {
								'chat.jsonl': [
									JSON.stringify({
										timestamp: '2025-01-10T10:00:00.000Z',
										message: {
											id: 'msg_123',
											model: 'claude-opus-4-6',
											usage: {
												input_tokens: 100,
												output_tokens: 25,
												cache_creation_input_tokens: 10,
												cache_read_input_tokens: 5,
											},
										},
										requestId: 'req_456',
										costUSD: 0.001,
									}),
									JSON.stringify({
										timestamp: '2025-01-10T10:00:01.000Z',
										message: {
											id: 'msg_123',
											model: 'claude-opus-4-6',
											usage: {
												input_tokens: 100,
												output_tokens: 250,
												cache_creation_input_tokens: 10,
												cache_read_input_tokens: 5,
												speed: 'standard',
											},
										},
										requestId: 'req_456',
										costUSD: 0.01,
									}),
								].join('\n'),
							},
						},
					},
				});

				const data = await loadDailyUsageData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(data).toHaveLength(1);
				expect(data[0]?.inputTokens).toBe(100);
				expect(data[0]?.outputTokens).toBe(250);
				expect(data[0]?.totalCost).toBe(0.01);
			});
		});

		describe('loadSessionData with deduplication', () => {
			it('should deduplicate entries across sessions', async () => {
				await using fixture = await createFixture({
					projects: {
						project1: {
							session1: {
								'file1.jsonl': JSON.stringify({
									timestamp: '2025-01-10T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
							session2: {
								'file2.jsonl': JSON.stringify({
									timestamp: '2025-01-15T10:00:00Z',
									message: {
										id: 'msg_123',
										usage: {
											input_tokens: 100,
											output_tokens: 50,
										},
									},
									requestId: 'req_456',
									costUSD: 0.001,
								}),
							},
						},
					},
				});

				const sessions = await loadSessionData({
					claudePath: fixture.path,
					mode: 'display',
				});

				expect(sessions).toHaveLength(1);
				expect(sessions[0]?.inputTokens).toBe(100);
				expect(sessions[0]?.outputTokens).toBe(50);
			});
		});
	});

	describe('getClaudePaths', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		});

		it('returns paths from environment variable when set', async () => {
			await using fixture1 = await createFixture({
				projects: {},
			});
			await using fixture2 = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture1.path},${fixture2.path}`);

			const paths = getClaudePaths();
			const normalizedFixture1 = path.resolve(fixture1.path);
			const normalizedFixture2 = path.resolve(fixture2.path);

			expect(paths).toEqual(expect.arrayContaining([normalizedFixture1, normalizedFixture2]));
			// Environment paths should be prioritized
			expect(paths[0]).toBe(normalizedFixture1);
			expect(paths[1]).toBe(normalizedFixture2);
		});

		it('filters out non-existent paths from environment variable', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture.path},/nonexistent/path`);

			const paths = getClaudePaths();
			const normalizedFixture = path.resolve(fixture.path);
			expect(paths).toEqual(expect.arrayContaining([normalizedFixture]));
			expect(paths[0]).toBe(normalizedFixture);
		});

		it('removes duplicates from combined paths', async () => {
			await using fixture = await createFixture({
				projects: {},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture.path},${fixture.path}`);

			const paths = getClaudePaths();
			const normalizedFixture = path.resolve(fixture.path);
			// Should only contain the fixture path once (but may include defaults)
			const fixtureCount = paths.filter((p) => p === normalizedFixture).length;
			expect(fixtureCount).toBe(1);
		});

		it('returns non-empty array with existing default paths', () => {
			// This test will use real filesystem checks for default paths
			vi.stubEnv('CLAUDE_CONFIG_DIR', '');
			const paths = getClaudePaths();

			expect(Array.isArray(paths)).toBe(true);
			// At least one path should exist in our test environment (CI creates both)
			expect(paths.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe('multiple paths integration', () => {
		it('loadDailyUsageData aggregates data from multiple paths', async () => {
			await using fixture1 = await createFixture({
				projects: {
					project1: {
						session1: {
							'usage.jsonl': JSON.stringify({
								timestamp: '2024-01-01T12:00:00Z',
								message: { usage: { input_tokens: 100, output_tokens: 50 } },
								costUSD: 0.01,
							}),
						},
					},
				},
			});

			await using fixture2 = await createFixture({
				projects: {
					project2: {
						session2: {
							'usage.jsonl': JSON.stringify({
								timestamp: '2024-01-01T13:00:00Z',
								message: { usage: { input_tokens: 200, output_tokens: 100 } },
								costUSD: 0.02,
							}),
						},
					},
				},
			});

			vi.stubEnv('CLAUDE_CONFIG_DIR', `${fixture1.path},${fixture2.path}`);

			const result = await loadDailyUsageData();
			// Find the specific date we're testing
			const targetDate = result.find((day) => day.date === '2024-01-01');
			expect(targetDate).toBeDefined();
			expect(targetDate?.inputTokens).toBe(300);
			expect(targetDate?.outputTokens).toBe(150);
			expect(targetDate?.totalCost).toBe(0.03);
		}, 30000);
	});

	describe('JSONL worker count', () => {
		it('uses more workers for daily and session tasks than block-style defaults', () => {
			const availableParallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(11);
			try {
				expect(getDefaultJSONLWorkerThreadCount(100)).toBe(6);
				expect(getDefaultJSONLWorkerThreadCount(100, true)).toBe(9);
			} finally {
				availableParallelism.mockRestore();
			}
		});

		it('does not exceed the number of files', () => {
			const availableParallelism = vi.spyOn(os, 'availableParallelism').mockReturnValue(11);
			try {
				expect(getDefaultJSONLWorkerThreadCount(5, true)).toBe(5);
			} finally {
				availableParallelism.mockRestore();
			}
		});
	});

	describe('daily worker column encoding', () => {
		it('round-trips daily worker entries', () => {
			const entries: DailyDataEntry[] = [
				{
					date: '2026-05-13',
					cost: 1.25,
					inputTokens: 1,
					outputTokens: 2,
					cacheCreationTokens: 3,
					cacheReadTokens: 4,
					model: 'opus-4-7-fast',
					project: 'ccusage',
					uniqueHash: 'message:request',
					tokenTotal: 10,
					hasSpeed: true,
				},
				{
					date: '2026-05-14',
					cost: 0,
					inputTokens: 5,
					outputTokens: 6,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					model: undefined,
					project: 'ccusage',
					uniqueHash: null,
					tokenTotal: 11,
					hasSpeed: false,
				},
			];

			expect(decodeDailyDataEntries(encodeDailyDataEntries(entries))).toEqual(entries);
		});
	});

	describe('session worker column encoding', () => {
		it('round-trips session worker entries', () => {
			const entries: SessionDataEntry[] = [
				{
					sessionKey: 'project/session-a',
					sessionId: 'session-a',
					projectPath: 'project',
					cost: 1.25,
					timestamp: '2026-05-14T01:02:03.000Z',
					model: 'haiku-4-5',
					inputTokens: 1,
					outputTokens: 2,
					cacheCreationTokens: 3,
					cacheReadTokens: 4,
					uniqueHash: 'message:request',
					tokenTotal: 10,
					hasSpeed: false,
					version: '1.2.3' as Version,
				},
				{
					sessionKey: 'project/session-a',
					sessionId: 'session-a',
					projectPath: 'project',
					cost: 0,
					timestamp: '2026-05-14T02:03:04.000Z',
					model: undefined,
					inputTokens: 5,
					outputTokens: 6,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					uniqueHash: null,
					tokenTotal: 11,
					hasSpeed: true,
					version: undefined,
				},
			];

			expect(decodeSessionDataEntries(encodeSessionDataEntries(entries))).toEqual(entries);
		});
	});

	describe('block worker column encoding', () => {
		it('round-trips block worker entries', () => {
			const result: BlockFileResult = {
				file: '/tmp/project/session.jsonl',
				timestampMs: Date.UTC(2026, 4, 14, 1, 2, 3),
				entries: [
					{
						entry: {
							timestamp: new Date(Date.UTC(2026, 4, 14, 1, 2, 3)),
							timestampMs: Date.UTC(2026, 4, 14, 1, 2, 3),
							usage: {
								inputTokens: 1,
								outputTokens: 2,
								cacheCreationInputTokens: 3,
								cacheReadInputTokens: 4,
							},
							costUSD: 1.25,
							model: 'haiku-4-5',
							version: '1.2.3',
							usageLimitResetTime: new Date(Date.UTC(2026, 4, 14, 2, 0, 0)),
						},
						uniqueHash: 'message:request',
						tokenTotal: 10,
						hasSpeed: true,
					},
					{
						entry: {
							timestamp: new Date(Date.UTC(2026, 4, 14, 3, 4, 5)),
							timestampMs: Date.UTC(2026, 4, 14, 3, 4, 5),
							usage: {
								inputTokens: 5,
								outputTokens: 6,
								cacheCreationInputTokens: 0,
								cacheReadInputTokens: 0,
							},
							costUSD: 0,
							model: 'unknown',
						},
						uniqueHash: null,
						tokenTotal: 11,
						hasSpeed: false,
					},
				],
			};

			expect(decodeBlockFileResult(encodeBlockFileResult(result))).toEqual(result);
		});
	});

	describe('globUsageFiles', () => {
		it('should glob files from multiple paths in parallel with base directories', async () => {
			await using fixture = await createFixture({
				'path1/projects/project1/session1/usage.jsonl': 'data1',
				'path2/projects/project2/session2/usage.jsonl': 'data2',
				'path3/projects/project3/session3/usage.jsonl': 'data3',
			});

			const paths = [fixture.getPath('path1'), fixture.getPath('path2'), fixture.getPath('path3')];

			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(3);
			expect(results.some((r) => r.file.includes('project1'))).toBe(true);
			expect(results.some((r) => r.file.includes('project2'))).toBe(true);
			expect(results.some((r) => r.file.includes('project3'))).toBe(true);

			// Check base directories are included
			const result1 = results.find((r) => r.file.includes('project1'));
			expect(result1?.baseDir).toContain(path.join('path1', 'projects'));
		});

		it('should handle errors gracefully and return empty array for failed paths', async () => {
			await using fixture = await createFixture({
				'valid/projects/project1/session1/usage.jsonl': 'data1',
			});

			const paths = [
				fixture.getPath('valid'),
				fixture.getPath('nonexistent'), // This path doesn't exist
			];

			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(1);
			expect(results.at(0)?.file).toContain('project1');
		});

		it('should return empty array when no files found', async () => {
			await using fixture = await createFixture({
				'empty/projects': {}, // Empty directory
			});

			const paths = [fixture.getPath('empty')];
			const results = await globUsageFiles(paths);

			expect(results).toEqual([]);
		});

		it('should handle multiple files from same base directory', async () => {
			await using fixture = await createFixture({
				'path1/projects/project1/session1/usage.jsonl': 'data1',
				'path1/projects/project1/session2/usage.jsonl': 'data2',
				'path1/projects/project2/session1/usage.jsonl': 'data3',
			});

			const paths = [fixture.getPath('path1')];
			const results = await globUsageFiles(paths);

			expect(results).toHaveLength(3);
			expect(results.every((r) => r.baseDir.includes(path.join('path1', 'projects')))).toBe(true);
		});
	});

	// Test for calculateContextTokens
	describe('calculateContextTokens', async () => {
		it('returns null when transcript cannot be read', async () => {
			const result = await calculateContextTokens('/nonexistent/path.jsonl');
			expect(result).toBeNull();
		});
		const { createFixture } = await import('fs-fixture');
		it('parses latest assistant line and excludes output tokens', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'user', message: {} }),
					JSON.stringify({
						type: 'assistant',
						message: { usage: { input_tokens: 1000, output_tokens: 999 } },
					}),
					JSON.stringify({
						type: 'assistant',
						message: {
							usage: {
								input_tokens: 2000,
								cache_creation_input_tokens: 100,
								cache_read_input_tokens: 50,
							},
						},
					}),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			// Should pick the last assistant line and exclude output tokens
			expect(res?.inputTokens).toBe(2000 + 100 + 50);
			expect(res?.percentage).toBeGreaterThan(0);
		});

		it('handles missing cache fields gracefully', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1000 } } }),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			expect(res?.inputTokens).toBe(1000);
			expect(res?.percentage).toBeGreaterThan(0);
		});

		it('clamps percentage to 0-100 range', async () => {
			await using fixture = await createFixture({
				'transcript.jsonl': [
					JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 300_000 } } }),
				].join('\n'),
			});
			const res = await calculateContextTokens(fixture.getPath('transcript.jsonl'));
			expect(res).not.toBeNull();
			expect(res?.percentage).toBe(100); // Should be clamped to 100
		});
	});
}
