# Vitest Style Examples

Use this reference when reviewing or teaching Vitest style. The main TDD
reference keeps the required workflow short; this file preserves expanded
bad/good examples.

## Expected Failures

Avoid `try`/`catch` for expected failures.

Bad:

```typescript
it('rejects invalid config', async () => {
	try {
		await loadConfig('bad.json');
		expect.fail('expected loadConfig to throw');
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
	}
});
```

Good:

```typescript
it('rejects invalid config', async () => {
	await expect(loadConfig('bad.json')).rejects.toThrow(Error);
});
```

## Branching

Avoid `if` branches inside test bodies.

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

## Helpers

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
