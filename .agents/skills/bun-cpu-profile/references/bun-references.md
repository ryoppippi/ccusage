# Bun References

Use Bun's local agent-readable docs before web docs. In this repo, the useful
Bun docs live in `node_modules/bun-types`.

Read this first for profiling flags and benchmarking guidance:

```sh
sed -n '1,280p' node_modules/bun-types/docs/project/benchmarking.mdx
```

Use the type files for runtime APIs used in this repo, such as `Bun.$`,
`Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.argv`, `Bun.deepEquals()`,
`Bun.file().writer()`, `Bun.stdout`, `Bun.stderr`, and `Bun.stringWidth()`:

```sh
rg -n "cpu-prof|cpu-prof-md|Bun\\.\\$|function file|function write|function spawn|argv|deepEquals|stringWidth" \
	node_modules/bun-types
```

Relevant local docs are usually under:

- `node_modules/bun-types/README.md`
- `node_modules/.pnpm/bun-types*/node_modules/bun-types/docs/project/benchmarking.mdx`
- `node_modules/.pnpm/bun-types*/node_modules/bun-types/bun.d.ts`

If local docs are unavailable, use Bun's benchmarking docs:
`https://bun.com/docs/project/benchmarking`.
