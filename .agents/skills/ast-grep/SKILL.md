---
name: ast-grep
description: Guides ccusage structural code searches with ast-grep. Use when finding syntax patterns, validating migrations, or writing AST-based search commands.
---

# ast-grep

Use ast-grep when a search needs syntax structure rather than plain text. Prefer `rg` for simple text search.

## Tooling

This repo provides `ast-grep` through `flake.nix`. Run commands from the Nix dev shell, or use `direnv exec .` when the shell is not already active:

```sh
direnv exec . ast-grep run --lang ts --pattern '/$P/' --json=stream apps packages
```

If `direnv` is unavailable and this is a one-off search, use comma as a fallback:

```sh
, ast-grep run --lang ts --pattern '/$P/' --json=stream apps packages
```

## Workflow

1. Describe the syntax shape you need to find.
2. Start with a small pattern and test it against the repo.
3. Use `--debug-query` when the pattern does not match the AST shape you expected.
4. Only move to YAML rules when `run --pattern` cannot express the search.

## Commands

For quick pattern searches:

```sh
ast-grep run --lang ts --pattern 'console.log($ARG)' apps packages
```

For JSON output that scripts can consume:

```sh
ast-grep run --lang ts --pattern '/$P/' --json=stream apps packages
```

## Rule Tips

- Use `run --pattern` for simple single-node matches.
- Use `scan --rule` or `scan --inline-rules` for relational rules such as `inside` or `has`.
- Add `stopBy: end` to relational rules so ast-grep searches the full direction.
- Use `--debug-query=ast`, `--debug-query=cst`, or `--debug-query=pattern` when a rule does not match the code shape you expected.
