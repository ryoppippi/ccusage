# Vitest Expected Failures

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
