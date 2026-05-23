# Commit Guidance

## Revertability

**Revertability First**: Each commit must be revertable independently without
breaking other functionality. Prefer smaller, granular commits over large
groupings. Split by hunks within files, not just entire files.

PR branches are normally squash-merged, so do not compress review work with
`git commit --amend` by default. Keep review fixes as small follow-up commits
that can be reverted independently. Amend only for unpublished local mistakes or
when the user explicitly asks.

Tiny commits are expected. A single review comment, one wording correction, one
reference-file extraction, one symlink sync, or one generated formatting pass can
each be its own commit when independently revertable.

Tiny does not mean incomplete. For moves, renames, or extractions, one commit
must include both sides of the operation: remove or update the old location, add
the new location, update references, and sync generated links if required. Never
commit only the destination of a move while leaving the source/reference cleanup
for a later commit.

When in doubt, prefer smaller commits. On PR branches, stack small revertable
commits instead of amending away review history unless explicitly asked. Each
commit must pass: "If I revert this, will it break other features?"

## Message Format

```text
<type>(<scope>): <subject>

<body>

<footer>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`,
`ci`, `chore`, `revert`.

Body should explain:

- What changed and why.
- Problem context and solution rationale.
- Implementation decisions.
- Potential impacts.
- Wrap at 72 characters.

Subject should name the artifact or behavior changed:

- Prefer concrete subjects that make sense when read alone in a commit list.
- Avoid vague review-process subjects such as `chore: address review feedback`,
  `chore: apply comments`, or `fix: update per CodeRabbit`.
- Put reviewer context in the body, not the subject. For example, use
  `docs(skills): clarify reference routing` with a body explaining that it
  addresses CodeRabbit feedback.

Always use clear English for commit messages and keep wording compatible with
repository spell-check rules.
