---
name: nushell
description: Guides ccusage Nushell scripts. Use when adding, editing, formatting, or validating .nu scripts, Nix shebangs, GitHub Actions script calls, or just recipes that invoke Nushell.
paths:
  - '**/*.nu'
globs: '*.nu'
---

# ccusage Nushell

Use this skill for repository scripts written in Nushell, especially under
`.github/scripts/` and `apps/ccusage/scripts/`.

## Runtime Shape

- Prefer executable `.nu` scripts with a Nix shebang over adding `nushell` to a
  GitHub Actions profile install.
- Use `#!/usr/bin/env nix` plus a `nix shell --inputs-from` line when the script
  needs tools that should be pinned by the flake.
- Keep the shebang tool list to commands the script directly invokes.
- It is acceptable for a Nu script to call external tools such as `gh`, `jq`,
  `git`, `hyperfine`, `pnpm`, `node`, or `bun` when those tools are the right
  boundary. Prefer the shebang Nix shell to global installs.

Example:

```nu
#!/usr/bin/env nix
#! nix shell --inputs-from ../../.. nixpkgs#nushell nixpkgs#git --command nu
```

Adjust the `--inputs-from` relative path to the script location.

## Style

- Use structured Nushell data operations (`open`, records, lists, `from json`,
  `to json`, `transpose`, `where`, `each`) instead of ad hoc string parsing.
- Use `run-external` for commands where flags may be parsed by Nushell, and quote
  short flags such as `'-L'`, `'-x'`, `'-c'`, and `'-change'`.
- Keep command arguments as lists until the external boundary. When a string
  command is required, quote arguments that may contain spaces.
- Use `complete` when you need exit code, stdout, and stderr without throwing.
- Print progress to stderr for CI scripts whose stdout is a data artifact.

## Validation

Run syntax checks through Nix instead of assuming `nu` is on `PATH`:

```sh
nix shell --inputs-from . nixpkgs#nushell --command nu --commands 'nu-check path/to/script.nu'
```

Run formatting after edits:

```sh
just fmt
```

For behavior changes, add a focused smoke command that invokes the script via
its executable shebang, then run the repo check that owns the caller.
