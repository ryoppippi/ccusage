# ArkRegex

Use `arkregex` for regular expressions in TypeScript code unless there is a concrete reason a native regex literal is better.

## Source

Read <https://arktype.io/docs/blog/arkregex> when unsure about API details. The repo policy follows the article's core points:

- `regex(pattern, flags?)` is a typed wrapper around `new RegExp(pattern, flags)`.
- It provides typed `.test()`, `.exec()`, captures, and named groups from native JavaScript regex syntax.
- It is intended as a drop-in replacement for `new RegExp()`.
- It is designed to avoid runtime bundle impact; verify dist output when changing bundled entry points.
- If TypeScript inference is too expensive for a large pattern, use `regex.as<...>()` with explicit types.

## Repo Policy

- Import with `import { regex } from 'arkregex';`.
- Prefer named constants for reused or meaningful patterns:

```ts
const isoDateRegex = regex('^\\d{4}-\\d{2}-\\d{2}$');
```

- Inline `regex(...)` is acceptable for one-off simple calls such as `value.replace(regex('-', 'g'), '')`.
- Preserve regex flags explicitly as the second argument:

```ts
const pathRegex = regex('^[/\\\\-]+|[/\\\\-]+$', 'g');
```

- Keep pattern strings single-quoted and escape backslashes for string literals.
- Write newline matches with a real escaped newline in the string, for example `regex('\n$')`, not `regex('\\n$')`.
- Do not escape `/` inside `regex()` strings; use `regex('a/b')`, not `regex('a\\/b')`.
- For broad alternations or patterns that trigger `Type instantiation is excessively deep`, use `regex.as<...>()` with explicit types.
- Do not use regex literals such as `/.../` or `new RegExp(...)` in new TypeScript code.
- Do not convert unrelated non-TypeScript files unless requested.

## Dependencies

Bundled packages keep runtime libraries in `devDependencies`. If a package starts importing `arkregex`, add:

```text
"arkregex": "catalog:runtime"
```

Use the existing `pnpm-workspace.yaml` runtime catalog entry, or add one if it is missing.

## Migration Checklist

1. Find regex literals with ast-grep:

```sh
, ast-grep run --lang ts --pattern '/$P/' --json=stream apps packages
```

2. Replace literals with `regex('pattern', 'flags')`.
3. Add `arkregex` imports and package devDependencies where needed.
4. Run focused tests for changed files, then the repo's normal validation.
5. For bundled CLI changes, run `pnpm --filter ccusage build` and inspect the changed `dist/*.js` sizes if bundle size is a concern.
