# ArkRegex Source

Use `arkregex` for regular expressions in TypeScript code unless there is a
concrete reason a native regex literal is better.

Read <https://arktype.io/docs/blog/arkregex> when unsure about API details. The
repo policy follows the article's core points:

- `regex(pattern, flags?)` is a typed wrapper around `new RegExp(pattern,
flags)`.
- It provides typed `.test()`, `.exec()`, captures, and named groups from native
  JavaScript regex syntax.
- It is intended as a drop-in replacement for `new RegExp()`.
- It is designed to avoid runtime bundle impact; verify dist output when
  changing bundled entry points.
- If TypeScript inference is too expensive for a large pattern, use
  `regex.as<...>()` with explicit types.
