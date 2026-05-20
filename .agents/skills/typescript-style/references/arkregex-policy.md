# ArkRegex Policy

- Import with `import { regex } from 'arkregex';`.
- Prefer named constants for reused or meaningful patterns:

```ts
const isoDateRegex = regex('^\\d{4}-\\d{2}-\\d{2}$');
```

- Inline `regex(...)` is acceptable for one-off simple calls such as
  `value.replace(regex('-', 'g'), '')`.
- Preserve regex flags explicitly as the second argument:

```ts
const pathRegex = regex('^[/\\\\-]+|[/\\\\-]+$', 'g');
```

- Keep pattern strings single-quoted and escape backslashes for string literals.
- Prefer escaped newline patterns such as `regex('\\n$')` because they mirror
  regex literal syntax. `regex('\n$')` is also valid and matches the same
  newline.
- Do not escape `/` inside `regex()` strings; use `regex('a/b')`, not
  `regex('a\\/b')`.
- For broad alternations or patterns that trigger `Type instantiation is
excessively deep`, use `regex.as<...>()` with explicit types.
- Do not use regex literals such as `/.../` or `new RegExp(...)` in new
  TypeScript code.
- Do not convert unrelated non-TypeScript files unless requested.
