---
name: skill-creator
description: Guides repo-local skill creation and updates. Use when adding or editing .agents/skills, SKILL.md frontmatter, references, scripts, or skill routing.
---

# Skill Creator

Use this skill when creating or updating repo-local skills under `.agents/skills/`.

## Workflow

1. Decide whether a skill is needed. Add one only when repeated repo work needs specialized workflow, local references, command sequences, or policy that should trigger on demand.
2. Create or update `.agents/skills/<skill-name>/SKILL.md` with YAML frontmatter and concise Markdown instructions.
3. Keep `SKILL.md` focused on core workflow and navigation. Move detailed examples, APIs, or long checklists into `references/` files linked directly from `SKILL.md`.
4. Add scripts under `scripts/` only for deterministic or repeated operations that are better executed than rewritten.
5. Update the root `CLAUDE.md` Skill Routing list when adding a repo-local skill that agents should discover before work.
6. Run `pnpm run format` after edits and use the normal repo validation level for the change.

## Frontmatter

Required fields:

```yaml
---
name: skill-name
description: Describes what the skill does and when to use it.
---
```

Follow Anthropic's skill authoring guidance from the Agent Skills best practices and skill structure docs:

- The `description` field is the primary discovery mechanism.
- Write descriptions in third person.
- Include both what the skill does and concrete contexts, trigger phrases, file types, commands, or task classes for when to use it.
- Avoid vague descriptions such as "helps with docs" or "processes files".
- Keep metadata concise because skill names and descriptions are always loaded; Anthropic's size guidance treats frontmatter as roughly 100 words.

Optional file routing fields:

- Use `paths` for Claude-style file matching. It may be a comma-separated glob string or a YAML list.
- Add `globs` as a compatibility hint when a skill should trigger for file types across agent runtimes.
- For cross-agent repo-local skills that should apply to TypeScript or JavaScript, include both:

```yaml
paths:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.jsx'
globs: '*.ts,*.tsx,*.js,*.jsx'
```

- Do not rely only on path metadata for Codex-style discovery; keep the `description` explicit about the file types and actions that should trigger the skill.

For this repo, prefer one or two short sentences, usually around 20-35 words. Do not compress a description so far that it becomes only a label; the agent still needs enough trigger context to choose the skill reliably.

Good pattern:

```yaml
description: Guides ccusage tests. Use when adding or fixing in-source Vitest, fs-fixture data, CLI snapshots, Claude model pricing, or LiteLLM compatibility.
```

Weak pattern:

```yaml
description: Use for tests.
```

## Body

Keep the body procedural and repo-specific:

- Commands to run.
- Files or references to read.
- Local conventions that are easy to miss.
- Validation expected after changes.
- Small examples that prevent common mistakes.

Avoid explaining generic concepts the model already knows. The skill body is loaded only after the skill triggers, but it still competes with task context once loaded.

## References

Use reference files when details are conditional:

```text
.agents/skills/example-skill/
├── SKILL.md
└── references/
    ├── api.md
    └── examples.md
```

Link reference files directly from `SKILL.md` and say when to read each one. Avoid nested reference chains because agents may only preview intermediate files.
