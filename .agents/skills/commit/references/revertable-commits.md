# Revertable Commit Examples

## Good: split independent implementation steps

```text
feat(auth): add RefreshTokenService class

Added RefreshTokenService to handle token lifecycle management.
This service generates and invalidates refresh tokens with
configurable expiry periods.
```

```text
feat(auth): integrate token rotation in middleware

Updated auth middleware to call RefreshTokenService when validating
tokens. This can be reverted independently without removing the
service itself.
```

## Good: keep both sides of a move together

One commit contains:

- `A .agents/skills/tdd/references/vitest-examples.md`
- `M .agents/skills/tdd/SKILL.md`
- `D .agents/skills/tdd/vitest-example.md`

The commit is still small, but it is complete: the old path is removed, the new path is added, and every reference points to the new path.

## Bad: split one move across incomplete commits

First commit:

- `A .agents/skills/tdd/references/vitest-examples.md`

Second commit:

- `M .agents/skills/tdd/SKILL.md`
- `D .agents/skills/tdd/vitest-example.md`

The first commit is not independently revertable because it leaves duplicate or unreachable guidance until the second commit lands.

## Good: one review comment per commit

If a reviewer says “run format before typecheck/test”, one commit can update only that workflow wording and the matching always-on reminder. Keep unrelated examples, source docs, and typo fixes for separate commits.

## Bad: tidy broad commit

Avoid a commit that mixes:

- PR review workflow changes
- TypeScript assertion guidance
- OpenCode data-source corrections
- Markdown fence formatting
- Generated symlink sync

Even if each change is correct, reverting one concern would revert unrelated work.
