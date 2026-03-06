# Claude Harness — Tracer Bullet

Proof-of-concept orchestration harness for Claude Code Ralph loops with OpenTelemetry-style tracing.

## What this demonstrates

The full pipeline, end to end:

1. **RuntimeProvider** spawns `claude -p --output-format json` (WSL today, SSH/macOS later)
2. **SessionRunner** manages the Ralph loop — iteration control, exit detection, state machine
3. **ClaudeOutput** parses the structured JSON response from each invocation
4. **TraceCollector** records OTL spans per iteration and writes them to disk as JSON traces
5. **Callbacks** notify the future Tauri frontend of each iteration (IPC hookpoint)

## Architecture

```
┌──────────────────────────────────────────────────┐
│  main.rs                                         │
│  Configures the session and kicks off the loop   │
└──────────┬───────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│  session.rs — SessionRunner                      │
│  State machine: Idle → Running → Evaluating → …  │
│  Exit detection (completion signal + max iters)  │
│  Per-iteration: spawn → parse → record → decide  │
└──────┬─────────────┬─────────────┬───────────────┘
       │             │             │
       ▼             ▼             ▼
┌────────────┐ ┌──────────┐ ┌───────────────┐
│ runtime.rs │ │ output.rs│ │ otel.rs       │
│            │ │          │ │               │
│ WSL impl   │ │ Parse    │ │ SessionTrace  │
│ Mock impl  │ │ claude   │ │ IterationSpan │
│ (SSH todo) │ │ JSON     │ │ Write to disk │
└────────────┘ └──────────┘ └───────────────┘
```

## Quick start

### Mock mode (no Claude CLI needed)

```bash
cargo run -- mock
```

This runs 4 mock iterations (3 working + 1 completion), records OTL spans, and writes a trace file to `./traces/`.

### WSL mode (requires Claude Code installed in WSL)

```bash
# Point at your project repo
export HARNESS_REPO="/path/to/your/project"

cargo run -- wsl
```

Expects a `prd.md` and `progress.md` in the repo. Runs up to 5 iterations of `claude -p` via WSL.

## Trace output

Each session produces a JSON trace file in `./traces/`:

```json
{
  "trace_id": "a1b2c3...",
  "session_id": "...",
  "repo_path": "/home/user/my-project",
  "outcome": "completed",
  "total_cost_usd": 0.024,
  "total_iterations": 4,
  "iterations": [
    {
      "span_id": "...",
      "operation_name": "ralph.iteration.1",
      "duration_ms": 1200,
      "status": "OK",
      "attributes": {
        "iteration": 1,
        "cost_usd": 0.006,
        "num_turns": 3,
        "completion_signal_found": false,
        "exit_code": 0,
        "result_preview": "Working on task..."
      }
    }
  ]
}
```

These traces are designed to be importable into Jaeger or Grafana Tempo later. The schema maps to OTLP spans: one trace per session, one child span per iteration.

## Key design decisions

- **One process per iteration**: Each `claude -p` call is a short-lived process. The loop is owned by the harness, not by Claude's built-in Ralph plugin. This gives us full control over exit detection, retry logic, and tracing.

- **Git repo as context**: No state injection between iterations. Claude reads the repo fresh each time (PRD, progress file, git history). The prompt is static per loop.

- **One loop per repo**: The session manager enforces this. Multiple repos can run in parallel.

- **RuntimeProvider trait**: Adding SSH or macOS support means implementing one trait. The session runner doesn't know or care where Claude is running.

## What's next

This tracer proves the core loop works. Next steps toward the full harness:

1. **Tauri shell**: Wrap this in a Tauri app. The `on_iteration_complete` callback becomes a Tauri event emitted to the Svelte/React frontend.
2. **Session persistence**: Add SQLite to persist session state across app restarts.
3. **Concurrency manager**: `HashMap<PathBuf, Session>` with a global semaphore for rate limiting across parallel loops.
4. **Research/Plan mode**: Interactive mode proxy for the research phase, print mode for plan generation.
5. **SSH runtime**: Implement `RuntimeProvider` for SSH using `russh`.
6. **Dashboard**: Session table, iteration timeline, log viewer, OTL trace explorer.
