#!/usr/bin/env bun

type GitHubComment = {
	body?: string;
	id: number;
	user?: {
		login?: string;
	};
};

class GitHubRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'GitHubRequestError';
	}
}

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (value == null || value.length === 0) {
		throw new Error(`${name} is required`);
	}
	return value;
}

async function githubRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		...options,
		headers: {
			accept: 'application/vnd.github+json',
			authorization: `Bearer ${requiredEnv('GITHUB_TOKEN')}`,
			'content-type': 'application/json',
			'x-github-api-version': '2022-11-28',
			...options.headers,
		},
	});

	if (!response.ok) {
		throw new GitHubRequestError(
			`${options.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`,
			response.status,
		);
	}

	if (response.status === 204) {
		return undefined as T;
	}

	return response.json() as Promise<T>;
}

async function createComment(repository: string, prNumber: string, body: string): Promise<void> {
	await githubRequest(`/repos/${repository}/issues/${prNumber}/comments`, {
		method: 'POST',
		body: JSON.stringify({ body }),
	});
}

async function tryCreateComment(repository: string, prNumber: string, body: string): Promise<void> {
	try {
		await createComment(repository, prNumber, body);
	} catch (error) {
		if (isCommentWriteAuthFailure(error)) {
			console.warn(
				`Skipping PR comment because GitHub token cannot write comments: ${error.message}`,
			);
			return;
		}
		throw error;
	}
}

function isCommentWriteAuthFailure(error: unknown): error is GitHubRequestError {
	return error instanceof GitHubRequestError && (error.status === 401 || error.status === 403);
}

async function main(): Promise<void> {
	const repository = requiredEnv('GITHUB_REPOSITORY');
	const prNumber = requiredEnv('PR_NUMBER');
	const marker = requiredEnv('COMMENT_MARKER');
	const body = await Bun.file(requiredEnv('COMMENT_FILE')).text();
	const comments = await githubRequest<GitHubComment[]>(
		`/repos/${repository}/issues/${prNumber}/comments?per_page=100`,
	);
	const existing = comments.find(
		(comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(marker),
	);

	if (existing == null) {
		await tryCreateComment(repository, prNumber, body);
	} else {
		try {
			await githubRequest(`/repos/${repository}/issues/comments/${existing.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ body }),
			});
		} catch (error) {
			console.warn(`Failed to update existing PR comment; creating a new comment instead.`);
			console.warn(error);
			await tryCreateComment(repository, prNumber, body);
		}
	}
}

if (import.meta.vitest != null) {
	describe(isCommentWriteAuthFailure, () => {
		it('treats unauthenticated comment writes as skippable', () => {
			expect(isCommentWriteAuthFailure(new GitHubRequestError('unauthenticated', 401))).toBe(true);
		});

		it('treats forbidden comment writes as skippable', () => {
			expect(isCommentWriteAuthFailure(new GitHubRequestError('forbidden', 403))).toBe(true);
		});

		it('keeps other GitHub errors fatal', () => {
			expect(isCommentWriteAuthFailure(new GitHubRequestError('server error', 500))).toBe(false);
		});
	});
} else {
	await main();
}
