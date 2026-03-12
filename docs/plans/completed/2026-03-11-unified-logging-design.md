# Unified Logging with tauri-plugin-log

## Overview

Add unified logging to yarr using `tauri-plugin-log`. Both Rust backend and React frontend logs appear in a single console stream. File logging with size-based rotation is included from the start.

## Design

### Plugin Setup

Add `tauri-plugin-log` (Rust) and `@tauri-apps/plugin-log` (npm). Configure in `lib.rs` with two targets:

- **Console target** — Prints to stdout, visible in the `npx tauri dev` terminal
- **File target** — Writes to Tauri's default app log directory (`~/.local/share/com.yarr.desktop/logs/` on Linux) with size-based rotation: 5MB per file, 3 backups

Default log level is `info`. Override via `RUST_LOG` environment variable (e.g. `RUST_LOG=debug`).

### Frontend Integration

Import `attachConsole()` from `@tauri-apps/plugin-log` in the frontend entry point. This intercepts `console.log`, `console.warn`, `console.error` calls and forwards them to the Rust logging backend. Frontend code continues using `console.*` as normal.

### Backend Migration

Replace all `println!`/`eprintln!` calls with `tracing` macros:

- `println!("[harness] ...")` → `tracing::info!(...)`
- `eprintln!(...)` → `tracing::error!(...)`
- Pretty-printed trace summaries in `trace.rs` → `tracing::info!(...)`

Existing `tracing::info!`, `tracing::warn!`, `tracing::debug!` calls throughout `session.rs`, `runtime/local.rs`, `runtime/ssh.rs`, and `lib.rs` will start working once the subscriber is initialized by the plugin.

### Error Handling

None needed. If logging initialization fails, the plugin surfaces it at app startup. If a log call fails (e.g. file I/O issue), `tauri-plugin-log` silently drops the message.

### Testing

- Manual verification: `npx tauri dev`, confirm both backend and frontend logs appear in the terminal
- `cargo check` and `cargo test` to ensure the migration compiles
- `npx tsc --noEmit` to confirm the plugin import is correct

---

## Implementation Plan

### Task 1: Add tauri-plugin-log Rust dependency and initialize

Add the plugin crate and configure it in the Tauri builder with console + file targets, RUST_LOG support, and size-based rotation.

**Files to modify:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`
- `src-tauri/capabilities/default.json`

**Pattern reference:** `src-tauri/src/lib.rs` lines 681-684 (existing plugin init pattern)

**Details:**
- Add `tauri-plugin-log = "2"` to `[dependencies]` in Cargo.toml
- In `lib.rs`, add the plugin to the Tauri builder using the log plugin's builder API to configure: console target, file target with 5MB rotation and 3 backups, default level `info`, RUST_LOG env filter override
- Add `"log:default"` to the permissions array in `capabilities/default.json`

**Checklist:**
- [x] Add `tauri-plugin-log` to Cargo.toml
- [x] Initialize plugin in `lib.rs` with console + file targets
- [x] Add `"log:default"` permission
- [x] Enable `tracing` `log` feature for tracing→log bridge
- [x] `cd src-tauri && cargo check`

---

### Task 2: Add frontend log plugin and attach console

Install the npm package and wire up `attachConsole()` so frontend `console.*` calls route to the Rust backend.

**Files to modify:**
- `package.json` (via `npm install`)
- `src/main.tsx`

**Pattern reference:** `src/main.tsx` (frontend entry point), `package.json` lines 18-20 (existing plugin deps)

**Details:**
- `npm install @tauri-apps/plugin-log`
- In `main.tsx`, import `attachConsole` from `@tauri-apps/plugin-log` and call it before `createRoot`
- `attachConsole()` returns a detach function — store it but no need to call it (app lifecycle)

**Checklist:**
- [x] Install `@tauri-apps/plugin-log`
- [x] Call `attachConsole()` in `main.tsx`
- [x] Update browser mock if needed for dev/test environments
- [x] `npx tsc --noEmit`

---

### Task 3: Migrate println!/eprintln! in session.rs to tracing macros

Replace all print statements in the session runner with structured tracing calls.

**Files to modify:**
- `src-tauri/src/session.rs`

**Pattern reference:** `src-tauri/src/session.rs` existing `tracing::info!`/`tracing::warn!` calls

**Details:**
- `println!("[harness] ...")` → `tracing::info!(...)` — strip the `[harness]` prefix since tracing adds module context automatically
- `eprintln!("[harness] Error ...")` → `tracing::error!(...)`
- `println!()` (blank lines) → remove, tracing doesn't need visual separators
- `println!("  [{iteration}] tool: {name}")` → `tracing::debug!(iteration, name, "tool use")`
- `println!("  [{iteration}] text: {preview}")` → `tracing::debug!(iteration, preview, "text output")`

**Checklist:**
- [x] Migrate all 18 println!/eprintln! calls in session.rs
- [x] `cd src-tauri && cargo check`
- [x] `cd src-tauri && cargo test`

---

### Task 4: Migrate println! in trace.rs to tracing macros

Replace the pretty-printed trace summary output with tracing calls.

**Files to modify:**
- `src-tauri/src/trace.rs`

**Pattern reference:** `src-tauri/src/trace.rs` lines 1697-1740 (trace summary print block)

**Details:**
- The trace summary is a formatted report block with separators, headers, and tabular data
- Convert to `tracing::info!` calls — can consolidate multiple `println!` lines into fewer tracing calls with multi-line format strings
- Remove decorative separators (`"=".repeat(60)`) — keep the content, lose the ASCII art

**Checklist:**
- [x] Migrate all 16 println! calls in trace.rs
- [x] `cd src-tauri && cargo check`
- [x] `cd src-tauri && cargo test`

---

### Task 5: Verify end-to-end logging

Manual verification that everything works together.

**Checklist:**
- [ ] `npx tauri dev` — confirm backend tracing output appears in terminal (manual)
- [ ] Trigger a frontend `console.log` — confirm it appears in the same terminal (manual)
- [ ] Check log file is created in `~/.local/share/com.yarr.desktop/logs/` (manual)
- [ ] Set `RUST_LOG=debug` and confirm debug-level output appears (manual)
- [x] `npx tsc --noEmit`
- [x] `npm test` — 745 tests passed
- [x] `cd src-tauri && cargo test` — 361 tests passed

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add tauri-plugin-log Rust dependency and initialize | Done |
| 2 | Add frontend log plugin and attach console | Done |
| 3 | Migrate println!/eprintln! in session.rs | Done |
| 4 | Migrate println! in trace.rs | Done |
| 5 | Verify end-to-end logging | Automated checks done; manual verification remaining |
