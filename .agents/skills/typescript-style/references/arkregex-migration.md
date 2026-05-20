# ArkRegex Migration

Bundled packages keep runtime libraries in `devDependencies`. If a package
starts importing `arkregex`, add:

```text
"arkregex": "catalog:runtime"
```

Use the existing `pnpm-workspace.yaml` runtime catalog entry, or add one if it
is missing.

## Checklist

1. Find regex literals with ast-grep. Prefix with `,` to run ast-grep through
   comma when it is not already available:

```sh
, ast-grep run --lang ts --pattern '/$P/' --json=stream apps packages
```

2. Replace literals with `regex('pattern', 'flags')`.
3. Add `arkregex` imports and package devDependencies where needed.
4. Run focused tests for changed files, then the repo's normal validation.
5. For bundled CLI changes, run `pnpm --filter ccusage build` and inspect the
   changed `dist/*.js` sizes if bundle size is a concern.
