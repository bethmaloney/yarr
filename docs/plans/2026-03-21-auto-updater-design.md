# Auto-Updater Design

## Summary

Add automatic update checking and installation to Yarr using Tauri's built-in `tauri-plugin-updater` with GitHub Releases as the backend. The app checks for updates on startup, shows a non-intrusive notification when one is available, and lets the user install it with a confirmation that the app will restart.

## Architecture

```
GitHub Releases
  └─ latest.json (version, platform URLs, signatures)
       ↑ fetched by
  tauri-plugin-updater (Rust plugin, registered at startup)
       ↑ called from
  @tauri-apps/plugin-updater (JS API)
       ↑ used by
  Zustand store (updateAvailable state, checkForUpdates/installUpdate actions)
       ↑ rendered by
  Home toolbar (version label + update button) + Sonner toast on startup
```

## Update Flow

1. App starts → `initialize()` calls `checkForUpdates()` in background
2. Plugin fetches `https://github.com/bethmaloney/yarr/releases/latest/download/latest.json`
3. If newer version exists → store sets `updateAvailable` state
4. UI shows:
   - Toast notification with "Update available" message and action button
   - Persistent download button in Home toolbar header
5. User clicks "Install update"
6. Native confirmation dialog: "Update to vX.X.X? The app will close and restart to apply the update."
7. If confirmed → button shows "Downloading..." spinner
8. Download completes → signature verified → app exits → NSIS installer runs → app relaunches
9. On error → `toast.error()` with the actual error message

## Signing

- Ed25519 keypair generated with `npx tauri signer generate -w ~/.tauri/yarr.key`
- Public key stored in `tauri.conf.json` (committed to repo)
- Private key + password stored as GitHub Actions secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `tauri-action` uses these to sign artifacts and generate `latest.json`

## Version Display

- Current version shown in Home toolbar header as muted text (e.g., `v0.1.0`)
- Retrieved at runtime via `getVersion()` from `@tauri-apps/api/app`

## Configuration

**`tauri.conf.json` additions:**

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<generated-public-key>",
      "endpoints": [
        "https://github.com/bethmaloney/yarr/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

## Decisions

- **No polling**: Update check runs once on startup. Restart the app to recheck.
- **Draft releases as gate**: `releaseDraft: true` means updates aren't visible until manually published on GitHub.
- **Confirmation dialog**: Uses `tauri-plugin-dialog`'s `ask()` (already a dependency) to warn about restart before installing.
- **Windows-only for now**: Only NSIS target is configured. macOS/Linux targets can be added later as separate work.

---

## Implementation Plan

### Task 1: Add `tauri-plugin-updater` Rust dependency and register plugin

Add the updater plugin crate and register it in the Tauri app builder.

**Files to modify:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:1803-1804` — existing plugin registration for dialog and store

**Details:**
- Add `tauri-plugin-updater = "2"` to `[dependencies]` in Cargo.toml
- Register plugin with `app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;` alongside existing plugins

**Checklist:**
- [x] Add crate dependency
- [x] Register plugin in lib.rs
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Configure updater in `tauri.conf.json`

Add the bundle and plugin configuration for the updater.

**Files to modify:**
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`

**Pattern reference:** `src-tauri/tauri.conf.json` — existing bundle and app config

**Details:**
- Add `"createUpdaterArtifacts": true` to the `bundle` section
- Add `plugins.updater` section with `pubkey`, `endpoints`, and `windows.installMode`
- The pubkey will be a placeholder until the signing keypair is generated — use `"PLACEHOLDER"` and document that it must be replaced before the first release
- Add `"updater:default"` to the permissions array in `src-tauri/capabilities/default.json` (required for the frontend JS API to call the updater's IPC commands)

**Checklist:**
- [ ] Add `createUpdaterArtifacts` to bundle config
- [ ] Add updater plugin config with endpoint URL and placeholder pubkey
- [ ] Add `updater:default` permission to capabilities
- [ ] Verify: JSON is valid

---

### Task 3: Update release workflow with signing env vars

Pass the signing secrets to `tauri-action` so it generates signed artifacts and `latest.json`.

**Files to modify:**
- `.github/workflows/release.yml`

**Pattern reference:** `.github/workflows/release.yml:42-49` — existing `tauri-action` step

**Details:**
- Add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars to the Build Tauri app step
- These reference GitHub Actions secrets that must be configured in the repo settings

**Checklist:**
- [ ] Add signing env vars to the build step
- [ ] Verify: YAML is valid

---

### Task 4: Add `@tauri-apps/plugin-updater` JS dependency

Install the frontend package for the updater plugin API.

**Files to modify:**
- `package.json`

**Details:**
- Add `@tauri-apps/plugin-updater` to dependencies

**Checklist:**
- [ ] `npm install @tauri-apps/plugin-updater`
- [ ] Verify: `npx tsc --noEmit`

---

### Task 5: Add update state and actions to Zustand store

Add the update check logic to the store, triggered during `initialize()`.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:171-609` — existing `initialize()` function with listeners and async loading

**Details:**
- Add state: `updateAvailable: { version: string; date: string; body: string } | null`, `updateDownloading: boolean`, and a ref to hold the update object
- Add `checkForUpdates()`: calls `check()` from `@tauri-apps/plugin-updater`, stores result in `updateAvailable`, fires `toast.info()` with action button
- Add `installUpdate()`: shows `ask()` confirmation dialog, sets `updateDownloading: true`, calls `downloadAndInstall()` on the stored update object, catches errors with `toast.error()`
- Add `dismissUpdate()`: clears `updateAvailable`
- Call `checkForUpdates()` at the end of `initialize()` — fire and forget (no await), so it doesn't block app startup
- The `check()` call needs to be wrapped in a try/catch — it will throw in dev mode (no updater endpoint) and should fail silently

**Checklist:**
- [ ] Add update state fields to store interface
- [ ] Implement `checkForUpdates` with toast notification
- [ ] Implement `installUpdate` with confirmation dialog and downloading state
- [ ] Implement `dismissUpdate`
- [ ] Call `checkForUpdates()` in `initialize()`
- [ ] Verify: `npx tsc --noEmit`

---

### Task 6: Add version label and update button to Home toolbar

Show the current app version and, when an update is available, an install button.

**Files to modify:**
- `src/pages/Home.tsx`

**Pattern reference:**
- `src/pages/Home.tsx:222-238` — existing toolbar right-side button group
- `src/pages/RepoDetail.tsx:536-540` — existing `ask()` dialog usage

**Details:**
- Import `getVersion` from `@tauri-apps/api/app`, call it on mount with `useEffect` and store in local state
- Show version as muted text in the header (e.g., `v0.1.0`)
- When `updateAvailable` is set, show an update button with `Download` icon (Lucide) and the new version number
- When `updateDownloading` is true, show a spinner and "Downloading..." text
- Button calls `installUpdate()` from the store

**Checklist:**
- [ ] Add version display to toolbar
- [ ] Add conditional update button
- [ ] Add downloading state UI
- [ ] Verify: `npx tsc --noEmit`
- [ ] Verify: `npx eslint .`

---

### Task 7: E2E test for update available UI

Test that the update notification renders correctly when the updater plugin reports an update.

**Files to modify:**
- `e2e/update.test.ts` (new)

**Pattern reference:** `e2e/fixtures.ts` — existing Tauri IPC mocking setup

**Details:**
- Mock the updater plugin's IPC calls via `window.__TAURI_INTERNALS__` to simulate an available update
- Verify the update button appears in the toolbar
- Verify clicking it shows the confirmation dialog text
- Verify the downloading state shows spinner text

**Checklist:**
- [ ] Create e2e test file with mocked updater
- [ ] Test update button visibility
- [ ] Test confirmation flow
- [ ] Verify: `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Rust plugin dependency and registration | Done |
| 2 | Updater config in tauri.conf.json | Not Started |
| 3 | Release workflow signing env vars | Not Started |
| 4 | JS plugin dependency | Not Started |
| 5 | Zustand store update logic | Not Started |
| 6 | Home toolbar version + update button | Not Started |
| 7 | E2E test for update UI | Not Started |
