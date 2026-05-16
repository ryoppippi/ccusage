---
layout: home

hero:
  name: ccusage
  text: Coding (Agent) CLI Usage Analysis
  tagline: A fast local CLI for tracking tokens and estimated costs across Claude Code, Codex, OpenCode, Amp, and pi-agent
  image:
    src: /logo.svg
    alt: ccusage logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/
    - theme: alt
      text: View on GitHub
      link: https://github.com/ryoppippi/ccusage

features:
  - icon: 📊
    title: All Sources by Default
    details: View all detected supported coding (agent) CLI usage by default
    link: /guide/all-reports
  - icon: 🤖
    title: Focused Views
    details: Start with all detected CLIs, then narrow the same usage views to one source when needed
    link: /guide/getting-started
  - icon: 📁
    title: Local Data Sources
    details: Reads local usage logs from Claude Code, Codex, OpenCode, Amp, and pi-agent without uploading your data
    link: /guide/
  - icon: 💰
    title: Cost Analysis
    details: Estimate USD spend from token counts and model pricing, with cache token accounting where available
    link: /guide/cost-modes
  - icon: 📋
    title: Enhanced Display
    details: Responsive terminal tables stay readable across wide and narrow terminals
  - icon: 📄
    title: JSON Output
    details: Export data in structured JSON format for programmatic use
    link: /guide/json-output
  - icon: ⏰
    title: Claude Code Features
    details: Blocks and statusline remain separate because they depend on Claude-specific local data and hooks
    link: /guide/claude/
  - icon: 🔄
    title: Cache Support
    details: Tracks cache creation and cache read tokens separately
  - icon: 🌐
    title: Offline Mode
    details: Use pre-cached pricing data without network connectivity
---

<div style="text-align: center; margin: 2rem 0;">
  <h2 style="margin-bottom: 1rem;">Support ccusage</h2>
  <p style="margin-bottom: 1.5rem;">If you find ccusage helpful, please consider sponsoring the development!</p>

  <h3 style="margin-bottom: 1rem;">Featured Sponsor</h3>
  <p style="margin-bottom: 1rem;">Check out <a href="https://www.youtube.com/watch?v=Ak6qpQ5qdgk" target="_blank">ccusage: The Claude Code cost scorecard that went viral</a></p>
  <a href="https://www.youtube.com/watch?v=Ak6qpQ5qdgk" target="_blank">
    <img src="/ccusage_thumbnail.png" alt="ccusage: The Claude Code cost scorecard that went viral" style="max-width: 600px; height: auto;">
  </a>

  <div style="margin-top: 2rem;">
    <a href="https://github.com/sponsors/ryoppippi" target="_blank">
      <img src="https://cdn.jsdelivr.net/gh/ryoppippi/sponsors@main/sponsors.svg" alt="Sponsors" style="max-width: 100%; height: auto;">
    </a>
  </div>
</div>
