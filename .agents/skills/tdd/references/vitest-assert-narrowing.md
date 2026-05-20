# Vitest Assert Narrowing

Use `assert` to make test preconditions explicit and to narrow nullable values.
Do not use non-null assertions when the test can fail with a useful message.

Bad:

```typescript
it('returns the first row', () => {
	const rows = getRows();

	expect(rows[0]!.id).toBe('row-1');
});
```

Good:

```typescript
it('returns the first row', () => {
	const rows = getRows();
	const firstRow = rows[0];
	assert.isDefined(firstRow, 'expected at least one row');

	expect(firstRow.id).toBe('row-1');
});
```
