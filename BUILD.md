# Building and Installing ccusage Locally

This guide explains how to build and install a custom version of ccusage for local development and testing.

## Prerequisites

- [Bun](https://bun.sh/) runtime (latest version)
- Node.js (for global installation via npm)
- Git (for version control)

## Quick Start

```bash
# 1. Clone and navigate to the project
git clone <your-fork-url>
cd ccusage

# 2. Install dependencies
bun install

# 3. Build the project
bun run build

# 4. Install globally with custom name
npm install -g .
```

## Build Scripts

The project includes these build-related scripts:

```bash
# Core build commands
bun run build          # Build distribution files
bun run typecheck       # Type check TypeScript
bun run format          # Format and lint code
bun run test            # Run test suite

# Quality assurance
bun run release         # Full release workflow (lint + typecheck + test + build)

# Development
bun run start           # Run from source
```

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
rm -rf dist/ node_modules/
bun install
bun run build
```

### Global Install Fails

```bash
# Try with npm instead of bun
npm install -g .

# Or try with sudo (macOS/Linux)
sudo npm install -g .
```

### Command Not Found

```bash
# Check if it's in your PATH
which your-custom-name

# Check npm global packages
npm list -g --depth=0

# Verify npm global bin directory
npm config get prefix
```

### Permission Issues

```bash
# Fix npm permissions (macOS/Linux)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'

# Add to ~/.bashrc or ~/.zshrc
export PATH=~/.npm-global/bin:$PATH
```

## New Features

- **Cost-based live monitoring**: `--cost-limit` option with numeric values or `max`
- **Model filtering**: `--model opus` or `--model opus,sonnet` for specific models
- **Per-model cost limits**: Historical maximums calculated per model
- **Improved projections**: Activity-aware calculations for sparse model usage
