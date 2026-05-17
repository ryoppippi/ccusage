# Installation

ccusage can be installed and used in several ways depending on your preferences and use case.

## Why No Installation Needed?

Thanks to ccusage's incredibly small bundle size, you don't need to install it globally. Unlike other CLI tools, we pay extreme attention to bundle size optimization, achieving an impressively small footprint even without minification. This means:

- ✅ Near-instant startup times
- ✅ Minimal download overhead
- ✅ Always use the latest version
- ✅ No global pollution of your system

## Quick Start (Recommended)

The fastest way to use ccusage is to run it directly:

::: code-group

```bash [bunx (Recommended)]
bunx ccusage
```

```bash [pnpm]
pnpm dlx ccusage
```

```bash [npx]
npx ccusage@latest
```

:::

::: tip Speed Recommendation
We recommend `bunx` for everyday use. ccusage can run on Node.js 22+, but Bun generally starts faster and avoids the slower cold-start path common with `npx`.

Because the published CLI shebang targets Node.js, package runners can start ccusage under Node.js even when launched through `bunx`. When ccusage finds `bun` in `PATH`, it automatically re-runs the bundled entrypoint with Bun for better warm runtime performance. Set `CCUSAGE_BUN_AUTO_RUN=0` to force the Node.js runtime.
:::

### Performance Comparison

Here's why runtime choice matters:

| Runtime  | First Run | Subsequent Runs | Notes                         |
| -------- | --------- | --------------- | ----------------------------- |
| bunx     | Fast      | **Instant**     | Recommended for everyday use  |
| pnpm dlx | Fast      | Fast            | Good alternative              |
| npx      | Slow      | Moderate        | Widely available, Node.js 22+ |

## Global Installation (Optional)

While not necessary due to our small bundle size, you can still install ccusage globally if you prefer:

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

- **Minimum**: Node.js 22.x for the published package
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
