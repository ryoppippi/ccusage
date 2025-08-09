/**
 * @fileoverview Test fixture factory functions for data-loader tests
 *
 * This module provides factory functions for creating test fixtures
 * used in data-loader.ts tests. Each function returns a function that
 * when called, creates the fixture data structure using fs-fixture.
 *
 * @module _fixtures
 */

import type { FsFixture } from 'fs-fixture';
import { createFixture } from 'fs-fixture';
import {
	createISOTimestamp,
	createMessageId,
	createModelName,
	createRequestId,
	createVersion,
} from './_types.ts';

type UsageData = {
	timestamp: string;
	message: {
		usage: {
			input_tokens: number;
			output_tokens: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
		model?: string;
		id?: string;
	};
	version?: string;
	costUSD?: number;
	request?: {
		id: string;
	};
};

/**
 * Creates an empty projects fixture
 */
export async function createEmptyProjectsFixture(): Promise<FsFixture> {
	return createFixture({
		projects: {},
	});
}

/**
 * Creates a fixture with basic usage data for testing daily aggregation
 */
export async function createDailyUsageFixture(data: {
	mockData1?: UsageData[];
	mockData2?: UsageData;
	project?: string;
	sessions?: Record<string, UsageData | UsageData[] | string>;
}): Promise<FsFixture> {
	const project = data.project ?? 'project1';
	const sessions = data.sessions ?? {};

	if (data.mockData1 != null && data.mockData2 != null) {
		sessions['session1.jsonl'] = data.mockData1
			.map(d => JSON.stringify(d))
			.join('\n');
		sessions['session2.jsonl'] = JSON.stringify(data.mockData2);
	}

	const projects: Record<string, Record<string, string>> = {};
	projects[project] = Object.fromEntries(
		Object.entries(sessions).map(([filename, sessionData]) => {
			if (typeof sessionData === 'string') {
				return [filename, sessionData];
			}
			if (Array.isArray(sessionData)) {
				return [filename, sessionData.map(d => JSON.stringify(d)).join('\n')];
			}
			return [filename, JSON.stringify(sessionData)];
		}),
	);

	return createFixture({ projects });
}

/**
 * Creates a fixture with session data
 */
export async function createSessionFixture(sessions: Array<{
	project?: string;
	sessionId: string;
	data: UsageData | UsageData[];
}>): Promise<FsFixture> {
	const projects: Record<string, Record<string, string>> = {};

	for (const session of sessions) {
		const project = session.project ?? 'project1';
		if (projects[project] == null) {
			projects[project] = {};
		}

		const filename = `${session.sessionId}.jsonl`;
		if (Array.isArray(session.data)) {
			projects[project][filename] = session.data
				.map(d => JSON.stringify(d))
				.join('\n');
		}
		else {
			projects[project][filename] = JSON.stringify(session.data);
		}
	}

	return createFixture({ projects });
}

/**
 * Creates a fixture with multiple projects
 */
export async function createMultiProjectFixture(projectData: Record<string, Record<string, UsageData | string>>): Promise<FsFixture> {
	const projects: Record<string, Record<string, string>> = {};

	for (const [projectPath, sessions] of Object.entries(projectData)) {
		projects[projectPath] = Object.fromEntries(
			Object.entries(sessions).map(([filename, data]) => {
				if (typeof data === 'string') {
					return [filename, data];
				}
				return [filename, JSON.stringify(data)];
			}),
		);
	}

	return createFixture({ projects });
}

/**
 * Creates a fixture with raw JSONL content (including invalid lines)
 */
export async function createRawJSONLFixture(project: string, sessionFile: string, content: string): Promise<FsFixture> {
	return createFixture({
		projects: {
			[project]: {
				[sessionFile]: content.trim(),
			},
		},
	});
}

/**
 * Creates a fixture for testing file timestamp operations
 */
export async function createTimestampTestFixture(files: Record<string, string | Record<string, string>>): Promise<FsFixture> {
	return createFixture(files);
}

/**
 * Common test data patterns
 */
export const testData = {
	basicUsageData: (timestamp: string, inputTokens: number, outputTokens: number, costUSD?: number): UsageData => ({
		timestamp: createISOTimestamp(timestamp),
		message: { usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
		...(costUSD !== undefined && { costUSD }),
	}),

	usageDataWithCache: (
		timestamp: string,
		inputTokens: number,
		outputTokens: number,
		cacheCreation: number,
		cacheRead: number,
		costUSD?: number,
	): UsageData => ({
		timestamp: createISOTimestamp(timestamp),
		message: {
			usage: {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
				cache_creation_input_tokens: cacheCreation,
				cache_read_input_tokens: cacheRead,
			},
		},
		...(costUSD !== undefined && { costUSD }),
	}),

	usageDataWithModel: (
		timestamp: string,
		inputTokens: number,
		outputTokens: number,
		model: string,
		costUSD?: number,
	): UsageData => ({
		timestamp: createISOTimestamp(timestamp),
		message: {
			usage: { input_tokens: inputTokens, output_tokens: outputTokens },
			model: createModelName(model),
		},
		...(costUSD !== undefined && { costUSD }),
	}),

	usageDataWithIds: (
		timestamp: string,
		inputTokens: number,
		outputTokens: number,
		messageId: string,
		requestId?: string,
		costUSD?: number,
	): UsageData => ({
		timestamp: createISOTimestamp(timestamp),
		message: {
			id: createMessageId(messageId),
			usage: { input_tokens: inputTokens, output_tokens: outputTokens },
		},
		...(requestId != null && { request: { id: createRequestId(requestId) } }),
		...(costUSD !== undefined && { costUSD }),
	}),

	usageDataWithVersion: (
		timestamp: string,
		inputTokens: number,
		outputTokens: number,
		version: string,
		costUSD?: number,
	): UsageData => ({
		timestamp: createISOTimestamp(timestamp),
		message: { usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
		version: createVersion(version),
		...(costUSD !== undefined && { costUSD }),
	}),

	sessionBlockData: (
		timestamp: string,
		messageId: string,
		inputTokens: number,
		outputTokens: number,
		model: string,
		costUSD?: number,
	) => ({
		timestamp,
		message: {
			id: messageId,
			usage: { input_tokens: inputTokens, output_tokens: outputTokens },
			model: createModelName(model),
		},
		...(costUSD !== undefined && { costUSD }),
	}),
};
