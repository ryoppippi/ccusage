# Revertable Move Commits

Good: keep both sides of a move together.

One commit contains:

- `A .agents/skills/tdd/references/vitest-examples.md`
- `M .agents/skills/tdd/SKILL.md`
- `D .agents/skills/tdd/vitest-example.md`

The commit is still small, but it is complete: the old path is removed, the new
path is added, and every reference points to the new path.

Bad: split one move across incomplete commits.

First commit:

- `A .agents/skills/tdd/references/vitest-examples.md`

Second commit:

- `M .agents/skills/tdd/SKILL.md`
- `D .agents/skills/tdd/vitest-example.md`

The first commit is not independently revertable because it leaves duplicate or
unreachable guidance until the second commit lands.
