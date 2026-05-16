---
name: fs-fixture
description: Use fs-fixture to create disposable filesystem trees for tests. Use when writing or reviewing tests that need temporary files, directories, template fixture copies, symlinks, or automatic cleanup with createFixture().
---

# fs-fixture

Use `fs-fixture` for tests that need realistic files or directories on disk.

## Reference

Read the local README before using less common options or APIs:

```text
node_modules/.pnpm/fs-fixture@2.8.1/node_modules/fs-fixture/README.md
```

If the exact pnpm store path changes, locate it with:

```sh
fd -a README.md node_modules/.pnpm | rg "fs-fixture"
```

## Default Pattern

Prefer `await using` so cleanup is automatic:

```ts
import { createFixture } from 'fs-fixture';

await using fixture = await createFixture({
	'projects/example/session.jsonl': '{}\n',
});

const filePath = fixture.getPath('projects/example/session.jsonl');
```

## Notes

- Use object trees for small inline fixtures.
- Use template directory input when many tests share the same larger fixture shape.
- Use `fixture.getPath(...)` instead of manually joining against `fixture.path`.
- Use `fixture.writeFile()` or `fixture.writeJson()` when a test needs to build data incrementally.
- Use `templateFilter` when copying only part of a template directory.
