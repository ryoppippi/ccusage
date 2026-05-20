# Vitest Branching

Avoid `if` branches inside test bodies. Split behaviors or use `it.each`.

Bad:

```typescript
it('formats output', () => {
	const output = formatReport(mode);

	if (mode === 'json') {
		expect(JSON.parse(output)).toEqual(expected);
	} else {
		expect(output).toContain('Total');
	}
});
```

Good:

```typescript
it('formats JSON output', () => {
	const output = formatReport('json');

	expect(JSON.parse(output)).toEqual(expected);
});

it('formats table output', () => {
	const output = formatReport('table');

	expect(output).toContain('Total');
});
```

Use `it.each` only when cases share one behavior.

```typescript
it.each([
	['daily', '2026-05-16'],
	['monthly', '2026-05'],
])('groups %s rows by period', (reportType, expectedPeriod) => {
	const rows = groupUsage(reportType, usage);

	expect(rows[0]?.period).toBe(expectedPeriod);
});
```
