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

# Frontend unit tests (vitest)
npm test

# E2E tests (Playwright — starts Vite dev server automatically)
npm run test:e2e
```

## Testing

- **Unit tests** (`src/*.test.ts`): Vitest with `vi.mock` for `@tauri-apps/plugin-store`. Run with `npm test`.
- **E2E tests** (`e2e/*.test.ts`): Playwright against the Vite dev server. Tauri IPC is mocked via `window.__TAURI_INTERNALS__` in `e2e/fixtures.ts`. Run with `npm run test:e2e`.
- **Rust tests** (`src-tauri/`): `cargo test` in the `src-tauri` directory.
