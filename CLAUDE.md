# Yarr

Desktop app that orchestrates Claude Code sessions (Ralph loops). Layer on top of `claude -p` using subscription auth.

## Tech Stack

- **Backend**: Rust, Tauri v2, Tokio
- **Frontend**: Svelte 5, TypeScript, Vite
- **Plugins**: tauri-plugin-dialog, tauri-plugin-store

## Project Layout

- `src/` — Svelte frontend (App.svelte, main.ts)
- `src-tauri/src/` — Rust backend (session runner, runtimes, prompt, tracing)

## Commands

```bash
# Dev with hot-reload
npx tauri dev

# Rust checks
cd src-tauri && cargo check
cd src-tauri && cargo test

# Frontend checks
npx tsc --noEmit
```
