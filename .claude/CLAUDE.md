# Claude Skills

`.claude/skills` is generated from `.agents/skills` by the Nix development environment.

Edit skills under `.agents/skills`, then enter the Nix dev shell with nix-direnv or run:

```sh
nix run .#sync-agent-skills
```
