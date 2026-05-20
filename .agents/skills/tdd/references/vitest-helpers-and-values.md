# Vitest Helpers And Values

Avoid wrapper/helper functions that hide behavior and assertions.

Bad:

```typescript
function expectReport(input: UsageEntry[], expected: ReportRow[]) {
	expect(renderDaily(input)).toEqual(expected);
}

it('renders daily totals', () => {
	expectReport(
		[{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }],
		[{ date: '2026-05-16', inputTokens: 100 }],
	);
});
```

Good:

```typescript
it('renders daily totals', () => {
	const input = [{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }];

	expect(renderDaily(input)).toEqual([{ date: '2026-05-16', inputTokens: 100 }]);
});
```

Tests do not need to be DRY. Prefer repeated, explicit setup over shared values
when duplication makes each behavior easier to read.

Avoid hoisting one-off values out of tests. Keep literals close to the behavior
they exercise.

Bad:

```typescript
const defaultTimezone = 'UTC';
const reportDate = '2026-05-16';

it('formats the daily heading', () => {
	expect(formatDailyHeading(reportDate, defaultTimezone)).toBe('2026-05-16');
});
```

Good:

```typescript
it('formats the daily heading', () => {
	expect(formatDailyHeading('2026-05-16', 'UTC')).toBe('2026-05-16');
});
```
