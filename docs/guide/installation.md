# Installation

ccusage can be installed and used in several ways depending on your preferences and use case.

## Why Direct Execution Works Well

You do not need to install ccusage globally before trying it. Direct package runners and Nix both work well for ad hoc usage:

- ✅ No global package to manage
- ✅ Easy access to the latest published version
- ✅ Cached package downloads after the first run
- ✅ Reproducible Nix builds when using the flake

## Quick Start (Recommended)

The fastest way to use ccusage is to run it directly:

::: code-group

```bash [bunx (Recommended)]
bunx ccusage
```

```bash [Nix]
nix run github:ryoppippi/ccusage -- daily
```

```bash [pnpm]
pnpm dlx ccusage
```

```bash [npx]
npx ccusage@latest
```

```bash [pkg.pr.new preview]
bunx -p https://pkg.pr.new/ryoppippi/ccusage@<pr-number> ccusage --offline
```

:::

::: tip Speed Recommendation
We recommend `bunx` for everyday use. ccusage can run on Node.js 22.11+, but Bun generally starts faster and avoids the slower cold-start path common with `npx`.

The npm package installs a small JavaScript launcher and the matching native binary package for your platform. Package runners such as `bunx` cache the downloaded package, so repeated runs reuse the cached native binary; the first run can still include network fetch time.
:::

### Performance Comparison

Here's why runtime choice matters:

| Runtime  | First Run | Subsequent Runs | Notes                            |
| -------- | --------- | --------------- | -------------------------------- |
| bunx     | Fast      | **Instant**     | Recommended for everyday use     |
| pnpm dlx | Fast      | Fast            | Good alternative                 |
| npx      | Slow      | Moderate        | Widely available, Node.js 22.11+ |

## Global Installation (Optional)

You can install ccusage globally if you prefer a persistent command:

::: code-group

```bash [npm]
npm install -g ccusage
```

```bash [bun]
bun install -g ccusage
```

```bash [yarn]
yarn global add ccusage
```

```bash [pnpm]
pnpm add -g ccusage
```

:::

After global installation, run commands directly:

```bash
ccusage daily
ccusage monthly --breakdown
ccusage blocks --live
```

## Development Installation

For development or contributing to ccusage:

```bash
# Clone the repository
git clone https://github.com/ryoppippi/ccusage.git
cd ccusage

# Install dependencies
pnpm install

# Run directly from source
pnpm --filter ccusage start daily
pnpm --filter ccusage start monthly --json
```

## Nix Flake

The repository exposes `ccusage` as the default Nix package and app:

```bash
nix run github:ryoppippi/ccusage
nix run github:ryoppippi/ccusage -- codex daily --offline
nix build github:ryoppippi/ccusage
```

The Nix package embeds LiteLLM pricing from the locked `litellm-pricing` flake input instead of fetching it during sandboxed builds. Maintainers can update that locked input and the non-Nix Cargo fallback JSON with:

```bash
nix flake update litellm-pricing
nix run .#update-pricing-fallback
nix flake check
```

The scheduled `update pricing` workflow runs the same commands and opens a PR when the locked input changes.

### Development Scripts

```bash
# Run tests
pnpm run test

# Type checking
pnpm typecheck

# Build distribution
pnpm --filter ccusage build

# Lint and format
pnpm run format
```

## Runtime Requirements

### Node.js

- **Minimum**: Node.js 22.11 for the published package
- **Recommended**: Use Bun for command execution when available
- `npx`, npm global installs, pnpm, and yarn all use the Node.js runtime unless ccusage re-runs through Bun

### Bun

- **Minimum**: Bun 1.3+
- **Recommended**: Latest stable release
- Recommended for `bunx ccusage` and for the fastest warm startup

## Verification

After installation, verify ccusage is working:

```bash
# Check version
ccusage --version

# Run help command
ccusage --help

# Test with daily report
ccusage daily
```

## Updating

### Direct Execution (npx/bunx)

Always gets the latest version automatically.

### Global Installation

```bash
# Update with npm
npm update -g ccusage

# Update with bun
bun update -g ccusage
```

### Check Current Version

```bash
ccusage --version
```

## Uninstalling

### Global Installation

::: code-group

```bash [npm]
npm uninstall -g ccusage
```

```bash [bun]
bun remove -g ccusage
```

```bash [yarn]
yarn global remove ccusage
```

```bash [pnpm]
pnpm remove -g ccusage
```

:::

### Development Installation

```bash
# Remove cloned repository
rm -rf ccusage/
```

## Troubleshooting Installation

### Permission Errors

If you get permission errors during global installation:

::: code-group

```bash [npm]
# Use npx instead of global install
npx ccusage@latest

# Or configure npm to use a different directory
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

```bash [Node Version Managers]
# Use nvm
nvm install 22
npm install -g ccusage

# Or use fnm
fnm install 22
npm install -g ccusage
```

:::

### Network Issues

If installation fails due to network issues:

```bash
# Try with different registry
npm install -g ccusage --registry https://registry.npmjs.org

# Or use bunx for offline-capable runs
bunx ccusage
```

### Version Conflicts

If you have multiple versions installed:

```bash
# Check which version is being used
which ccusage
ccusage --version

# Uninstall and reinstall
npm uninstall -g ccusage
npm install -g ccusage@latest
```

## Next Steps

After installation, check out:

- [Getting Started Guide](/guide/getting-started) - Your first usage report
- [Configuration](/guide/configuration) - Customize ccusage behavior
- [Daily Usage](/guide/daily-reports) - Understand daily usage patterns
