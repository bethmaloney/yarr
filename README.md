# Yarr — Yet Another Ralph Reigns

Desktop GUI that orchestrates Claude Code sessions — Ralph loops, research/planning, and a dashboard to monitor everything. Built on top of `claude -p` using subscription auth (no API keys).

## Architecture

```
yarr/
├── ui/                  # Svelte frontend
│   └── src/
│       └── App.svelte   # Dashboard UI
├── src-tauri/           # Rust backend
│   └── src/
│       ├── lib.rs       # Tauri commands + app entry
│       ├── output.rs    # Claude stream-json event types
│       ├── session.rs   # SessionRunner loop + state machine
│       ├── trace.rs     # OTel-style tracing (spans to JSON)
│       └── runtime/
│           ├── mod.rs   # RuntimeProvider trait
│           ├── wsl.rs   # WSL runtime
│           └── mock.rs  # Mock runtime for testing
```

```
┌────────────────────────────────────────────────┐
│  Svelte UI                                     │
│  Button → invoke("run_mock_session")           │
│  listen("session-event") → live event log      │
└──────────┬─────────────────────────────────────┘
           │ Tauri IPC
           ▼
┌────────────────────────────────────────────────┐
│  SessionRunner                                 │
│  State machine: Idle → Running → Evaluating →… │
│  Per-iteration: spawn → stream → record → next │
└──────┬─────────────┬─────────────┬─────────────┘
       │             │             │
       ▼             ▼             ▼
┌────────────┐ ┌──────────┐ ┌───────────────┐
│ runtime/   │ │ output.rs│ │ trace.rs      │
│            │ │          │ │               │
│ WSL impl   │ │ Parse    │ │ SessionTrace  │
│ Mock impl  │ │ stream-  │ │ IterationSpan │
│ (SSH todo) │ │ json     │ │ Write to disk │
└────────────┘ └──────────┘ └───────────────┘
```

## Quick start

```bash
# Install frontend deps
cd ui && npm install && cd ..

# Run the app (mock session, no Claude CLI needed)
cd ui && npx tauri dev
```

Click "Run Mock Session" — you'll see streaming events from 4 mock iterations (3 working + 1 completion), with a trace file written to `./traces/`.

## Key design decisions

- **stream-json, not json**: Uses `--output-format stream-json --verbose` for real-time event streaming, not batch JSON.

- **One process per iteration**: Each `claude -p` call is short-lived. The loop is owned by the harness, not Claude's built-in Ralph plugin.

- **Git repo as context**: No state injection between iterations. Claude reads the repo fresh each time (PRD, progress file, git history). The prompt is static per loop.

- **RuntimeProvider trait**: Adding SSH or macOS support means implementing one trait. The session runner doesn't care where Claude is running.

## Trace output

Each session produces a JSON trace in `./traces/`, designed for import into Jaeger or Grafana Tempo:

```json
{
  "trace_id": "a1b2c3...",
  "outcome": "completed",
  "total_cost_usd": 0.024,
  "total_iterations": 4,
  "iterations": [
    {
      "operation_name": "ralph.iteration.1",
      "duration_ms": 1200,
      "attributes": {
        "cost_usd": 0.006,
        "num_turns": 3,
        "completion_signal_found": false
      }
    }
  ]
}
```

## What's next

- Session persistence (SQLite)
- Concurrency manager with global rate limit semaphore
- Research/Plan interactive workflow
- SSH runtime
- Post-iteration hooks (lint, git push)
- Dashboard: session table, iteration timeline, trace explorer
