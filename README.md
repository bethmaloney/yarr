# Yarr — Yet Another Ralph Runner

A desktop app for running [Claude Code](https://docs.anthropic.com/en/docs/claude-code) in a loop. Point it at a repo and a plan file, and Yarr will repeatedly spawn `claude -p` until the work is done — managing iterations, checks, git operations, and cost tracking so you don't have to babysit a terminal.

Uses your existing Claude subscription auth. No API keys needed.

![Session detail view showing iterations, cost tracking, and result summary](screenshots/oneshot-detail.png)

## Why Yarr?

Running Claude Code in a loop (a "Ralph loop") means spawning `claude -p` over and over against a repo with a plan. Without tooling, you're left tabbing between terminals, eyeballing token spend, and manually re-running after failures. Yarr takes ownership of that loop:

- **Multiple repos at once** — Run concurrent sessions across different repositories from a single dashboard.
- **Cost and context tracking** — See token counts, dollar spend, and context window usage per iteration in real time.
- **Custom checks between iterations** — Define shell commands (lint, tests, type checks) that run after each iteration. Failed checks trigger automatic fix attempts.
- **Git workflow automation** — Branch creation, auto-push, and merge conflict resolution handled by Claude.
- **One-shot mode** — Single-purpose runs with a design phase followed by implementation. Supports resume on failure.
- **Full session traces** — Every session writes a JSON trace to `./traces/` with per-iteration breakdowns. Browse them in the built-in history view.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Platform-specific Tauri v2 dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Install and run

```bash
git clone <repo-url> && cd yarr2
npm install
npx tauri dev
```

This starts both the Vite dev server and the Tauri desktop app with hot-reload.

### Development commands

```bash
# Frontend type checking
npx tsc --noEmit

# Lint and format
npx eslint .
npx prettier --check .

# Frontend unit tests (Vitest)
npm test

# E2E tests (Playwright — starts Vite dev server automatically)
npm run test:e2e

# Rust checks and tests
cd src-tauri && cargo check
cd src-tauri && cargo test
```

## How it works

1. Add a repo (local path or SSH remote) and select a plan file — a markdown document describing what to build.
2. Yarr spawns `claude -p` with `--output-format stream-json --verbose`, streaming events back to the UI in real time.
3. Each iteration is a short-lived `claude -p` process. The loop is owned by Yarr, not Claude's session continuation.
4. Between iterations, Yarr runs any configured checks and git sync operations.
5. The session ends when Claude signals completion, hits the max iteration limit, or you stop it manually.
6. A full trace is written to `./traces/` for later review.

## Project structure

```
src/                    # React frontend (TypeScript, Tailwind, shadcn/ui)
  pages/                # Home, RepoDetail, RunDetail, OneShotDetail, History
  components/           # RepoCard, EventsList, HistoryTable, PlanProgressBar, ...
  store.ts              # Zustand store (repos, sessions, git status, one-shots)

src-tauri/src/          # Rust backend (Tauri v2, Tokio)
  lib.rs                # Tauri commands + app setup
  session.rs            # SessionRunner state machine (idle → running → evaluating → ...)
  oneshot.rs            # One-shot orchestration (design + implementation phases)
  output.rs             # Claude stream-json event parsing
  prompt.rs             # Prompt construction with plan file references
  trace.rs              # OTel-style session traces (JSON to disk)
  git_merge.rs          # Git merge conflict resolution via Claude
  ssh_orchestrator.rs   # SSH session management
  runtime/
    local.rs            # Local process execution
    ssh.rs              # Remote SSH execution
    wsl.rs              # WSL subprocess management
    mock.rs             # Mock runtime for tests
```
