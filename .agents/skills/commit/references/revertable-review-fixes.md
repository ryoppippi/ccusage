# Revertable Review Fix Commits

Good: one review comment per commit.

If a reviewer says "run format before typecheck/test", one commit can update
only that workflow wording and the matching always-on reminder. Keep unrelated
examples, source docs, and typo fixes for separate commits.

Bad: tidy broad commit.

Avoid a commit that mixes:

- PR review workflow changes
- TypeScript assertion guidance
- OpenCode data-source corrections
- Markdown fence formatting
- Generated symlink sync

Even if each change is correct, reverting one concern would revert unrelated
work.
