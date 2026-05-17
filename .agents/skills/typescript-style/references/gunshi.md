# Gunshi CLI

Use Gunshi for creating CLI commands instead of other libraries including cac, yargs, commander, etc.
Gunshi is a modern javascript command-line library

For more information, read the gunshi API docs in `node_modules/@gunshi/docs/**.md`.

## Type Inference

Let Gunshi infer command argument values from the concrete `args` object passed to `define()`. Avoid widening command types to `Command<Args>` or `ReturnType<typeof define>` because that erases the specific option keys and value types.

Prefer omitting command factory return types when the factory directly returns `define(...)`:

```ts
function createCommand() {
	return define({
		args: commandArgs,
		async run(ctx) {
			// ctx.values is inferred from commandArgs
		},
	});
}
```

For application packages, prefer the app-oriented ESLint preset when explicit return type rules would force redundant Gunshi factory annotations.

Only add an explicit Gunshi command type at real adapter boundaries; otherwise let `define(...)` and helper returns infer.

If a factory chooses between different argument sets, first try splitting it into typed helper factories and letting each helper infer its own `define(...)` result. Use overloads only when callers truly need literal-specific return types.
