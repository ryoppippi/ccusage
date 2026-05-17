---
name: bun-api-reference
description: Checks local bun-types documentation before using or changing Bun runtime APIs such as Bun.$, files, spawning, argv, stdout, stderr, and string width.
---

# Bun API Reference

Use this skill when writing, reviewing, or debugging code that calls Bun runtime APIs.

## Local References

Start with:

```text
node_modules/bun-types/README.md
node_modules/bun-types/docs/
```

Search local docs and types with `rg`:

```sh
rg "Bun\\.\\$|Bun\\.file|Bun\\.write|Bun\\.spawn" node_modules/bun-types
rg "stringWidth|deepEquals|stdout|stderr" node_modules/bun-types
```

Prefer the local `bun-types` documentation over memory when checking API signatures, return types, options, and subtle behavior.

## Common APIs To Verify

- `Bun.$`
- `Bun.file()`
- `Bun.write()`
- `Bun.spawn()`
- `Bun.argv`
- `Bun.deepEquals()`
- `Bun.file().writer()`
- `Bun.stdout`
- `Bun.stderr`
- `Bun.stringWidth()`

If the docs are missing or `node_modules` is unavailable, inspect existing local usage with `rg` and state the gap before relying on fallback knowledge.
