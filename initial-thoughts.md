Here's where we've landed:

**What we're building:** A desktop GUI that orchestrates Claude Code sessions — research/planning workflows, autonomous Ralph loops, and a dashboard to monitor everything. It's a layer on top of `claude -p`, using subscription auth (not API keys), so the Agent SDK is off the table.

**Tech stack:** Tauri with a Rust backend and Svelte frontend. Rust gives us strong process management for spawning Claude CLI processes, and the `RuntimeProvider` trait makes it straightforward to add new backends later. Svelte was suggested over React for its lighter weight and natural reactivity model for streaming process output, though you're open on frontend framework.

**Runtime strategy:** WSL on day one. SSH and macOS local come later. All three implement the same `RuntimeProvider` trait, so the rest of the codebase doesn't care where Claude is actually running.

**How Ralph loops work:** You own the loop, not the built-in Ralph plugin. Each iteration is a fresh `claude -p --output-format json` invocation — short-lived process, clean exit. The harness parses the structured JSON response, checks for completion signals, and decides whether to spawn the next iteration. Context between iterations is carried by the git repo itself (PRD + progress file + git history). The prompt is static per loop — Claude reads the repo state fresh each time.

**Concurrency model:** One active loop per repo, but many repos can run in parallel. A global semaphore or token bucket to manage the shared subscription rate limit across concurrent loops.

**Observability:** OpenTelemetry-style tracing. One trace per Ralph session, one child span per iteration. Each span captures cost, duration, turn count, exit code, completion signal detection, and a result preview. Traces persist as JSON files to disk, designed to be loadable into Jaeger or Grafana Tempo later.

**Research/Plan workflow:** Two separate outputs — `research.md` and `plan.md`. Research requires interactive Q&A (Claude asks questions, user answers), so it runs Claude in interactive mode proxied through the app's UI. Plan generation uses print mode against the research output. Both support feedback loops — v1 is a "refine" button that re-runs with appended feedback, with later consideration of something like Beads for structured plan representation.

**Dashboard:** A session table showing one row per repo with status, iteration count, cost, and last activity. Drill into any session for iteration timeline, logs, and OTL traces. Ability to launch new loops and stop running ones.

**Decisions still open:** Beads integration for structured plans (later), exact rate limiting strategy across parallel loops, and how to handle long prompts (stdin piping vs temp files vs `--system-prompt-file`).