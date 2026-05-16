---
name: typescript-style
description: Apply ccusage TypeScript style rules, especially preferring satisfies and as const satisfies over unsafe as assertions. Use when writing or reviewing TypeScript or TSX code, test fixtures, typed object literals, mocks, config objects, or table-driven cases.
---

# TypeScript Style

## Prefer `satisfies` Over `as`

Avoid `as` type assertions and especially `as any`. Use `satisfies` when checking object literals, mocks, config objects, fixture data, and expected rows.

Bad:

```ts
const config = { port: 3000, host: 'localhost' } as ServerConfig;
const ctx = { fetchDirent: vi.fn(), addReadHistory: vi.fn() } as any;
```

Good:

```ts
const config = { port: 3000, host: 'localhost' } satisfies ServerConfig;
const ctx = { fetchDirent: vi.fn(), addReadHistory: vi.fn() } satisfies MockContext;
```

## Use `as const satisfies`

Use `as const satisfies` for static literal data when preserving exact literal values or readonly tuples helps TypeScript catch mistakes.

Good:

```ts
const ROUTES = {
	home: '/',
	about: '/about',
} as const satisfies Record<string, string>;
```

Good for table-driven cases:

```ts
const reportCases = [
	{ type: 'daily', period: '2026-05-16' },
	{ type: 'monthly', period: '2026-05' },
] as const satisfies readonly ReportCase[];
```

## Acceptable `as`

Use `as` only when `satisfies` cannot express the operation, such as narrowing data returned from an external untyped boundary or adapting to an API that requires a nominal type. Keep it local and avoid `as any`.

## Prefer `@ts-expect-error`

Use `@ts-expect-error` instead of `@ts-ignore`, and include a short explanation. `@ts-expect-error` fails when the underlying type error disappears, so stale suppressions are caught.

Bad:

<!-- eslint-skip -->

```ts
// @ts-ignore
import privateApi from 'some-package/private-api';
```

## Exhaustive Switches

Use `satisfies never` after switches over discriminated unions or literal unions so new variants fail typecheck until the branch is handled.

Good:

```ts
switch (agent) {
	case 'claude':
		return loadClaude();
	case 'codex':
		return loadCodex();
	default:
		// exhaustiveness check for new agents added to the union
		agent satisfies never;
		throw new Error(`Unsupported agent: ${agent}`);
}
```

Good:

```ts
// @ts-expect-error Private runtime API has no public type declaration.
import privateApi from 'some-package/private-api';
```
