# Yarr — Yet Another Ralph Runner

Desktop app that orchestrates [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions. Run Ralph loops, fire off one-shots, and monitor everything from a single dashboard. Built on `claude -p` with subscription auth — no API keys needed.

## Why Yarr?

Running Claude Code in a loop (a "Ralph loop") means spawning `claude -p` repeatedly against a repo with a plan file. Yarr takes ownership of that loop so you can:

- **Run multiple repos concurrently** from one place
- **Track cost, context usage, and iterations** in real time
- **Add custom checks** (lint, tests) that run between iterations or after completion
- **Handle git workflows** — branch creation, push, and merge conflict resolution via Claude
- **Review full session traces** with per-iteration breakdowns

## Features

**Repository management** — Add local or SSH-remote repos. See git status (branch, dirty files, ahead/behind) at a glance.

**Ralph loops** — Pick a plan file, configure model/effort/max iterations, and run. Yarr spawns one `claude -p` process per iteration. No state is injected between iterations — Claude reads fresh repo context each time.

**One-shots** — Single-purpose runs with a design phase followed by implementation. Supports resume on failure and configurable merge strategies.

**Live monitoring** — Stream events as they happen: tool use, assistant text, check results, git sync status. Events are grouped by iteration with expandable detail.

**Custom checks** — Define checks (shell commands) that run after each iteration or post-completion. Failed checks trigger automatic fix attempts.

**Git sync** — Optional auto-push with conflict detection and Claude-assisted resolution.

**Session traces** — Every session writes a JSON trace to `./traces/` with outcome, cost, token counts, context usage, and per-iteration spans. Browse and inspect traces in the history view.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) (stable toolchain)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Platform-specific Tauri v2 dependencies — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Setup

```bash
# Clone the repo
git clone <repo-url> && cd yarr3

# Install frontend dependencies
npm install

# Run in development mode (starts both Vite dev server and Tauri app)
npx tauri dev
```

## Development

```bash
# Frontend type checking
npx tsc --noEmit

# Lint / format
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

## How it works

1. You add a repo and select a plan file (a markdown document describing what to build).
2. Yarr spawns `claude -p` with `--output-format stream-json --verbose`, streaming events back to the UI in real time.
3. Each iteration is a short-lived `claude -p` process. The loop is owned by Yarr, not Claude's built-in session continuation.
4. Between iterations, Yarr runs any configured checks and git sync operations.
5. The session ends when Claude signals completion, hits the max iteration limit, or you stop it manually.
6. A full trace is written to `./traces/` for later review.
