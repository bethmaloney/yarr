import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const REPO_FIXTURE = {
  id: "repo-1",
  path: "/home/user/repos/my-project",
  name: "my-project",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

const SAMPLE_TRACE = {
  session_id: "sess-abc-123",
  repo_path: "/home/user/repos/my-project",
  repo_id: "repo-1",
  prompt: "Fix login bug",
  plan_file: "plans/fix-login.md",
  start_time: "2026-03-07T08:30:00Z",
  end_time: "2026-03-07T08:42:15Z",
  outcome: "completed",
  failure_reason: null,
  total_iterations: 3,
  total_cost_usd: 0.4521,
  total_input_tokens: 45200,
  total_output_tokens: 12350,
  total_cache_read_tokens: 8200,
  total_cache_creation_tokens: 3100,
};

const SAMPLE_EVENTS = [
  { kind: "session_started", session_id: "sess-abc-123", _ts: 1741336200000 },
  { kind: "iteration_started", iteration: 1, _ts: 1741336201000 },
  { kind: "assistant_text", iteration: 1, text: "Working on the fix...", _ts: 1741336205000 },
  { kind: "iteration_complete", iteration: 1, result: { total_cost_usd: 0.1523 }, _ts: 1741336230000 },
  { kind: "session_complete", outcome: "completed", _ts: 1741336335000 },
];

/**
 * Navigate from Home -> History -> RunDetail by clicking through the UI.
 */
async function navigateToRunDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
) {
  await mockTauri({
    storeData: {
      repos: [REPO_FIXTURE],
    },
    invokeHandlers: {
      list_traces: () => [SAMPLE_TRACE],
      get_trace: () => SAMPLE_TRACE,
      get_trace_events: () => SAMPLE_EVENTS,
    },
  });
  await page.goto("/");

  // Home -> History
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

  // History -> RunDetail (click the trace row)
  await page.locator(".trace-row").first().click();
  await expect(page.locator("h1", { hasText: "Run Detail" })).toBeVisible();
}

test.describe("RunDetail — session ID copy button", () => {
  test("session ID text is displayed", async ({ page, mockTauri }) => {
    await navigateToRunDetail(page, mockTauri);

    // The session ID should be visible in the summary section
    const summary = page.locator(".summary");
    await expect(summary.getByText("sess-abc-123", { exact: true })).toBeVisible();
  });

  test("Copy button is visible next to session ID", async ({ page, mockTauri }) => {
    await navigateToRunDetail(page, mockTauri);

    // There should be a "Copy" button within the summary section, near the session ID
    const summary = page.locator(".summary");
    await expect(summary).toBeVisible();

    const copyButton = summary.getByRole("button", { name: "Copy" });
    await expect(copyButton).toBeVisible();
  });

  test("Copy button shows 'Copied!' feedback after click", async ({ page, mockTauri }) => {
    await navigateToRunDetail(page, mockTauri);

    // Mock navigator.clipboard.writeText to capture the written value
    await page.evaluate(() => {
      (window as any).__clipboardWritten = null;
      if (!navigator.clipboard) {
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async (text: string) => { (window as any).__clipboardWritten = text; } },
          writable: true,
        });
      } else {
        navigator.clipboard.writeText = async (text: string) => { (window as any).__clipboardWritten = text; };
      }
    });

    const summary = page.locator(".summary");
    const copyButton = summary.getByRole("button", { name: "Copy" });
    await expect(copyButton).toBeVisible();

    // Click the Copy button
    await copyButton.click();

    // Verify the correct session ID was written to the clipboard
    const written = await page.evaluate(() => (window as any).__clipboardWritten);
    expect(written).toBe("sess-abc-123");

    // Button text should change to "Copied!"
    await expect(summary.getByRole("button", { name: "Copied!" })).toBeVisible();

    // After 1.5 seconds, it should revert back to "Copy"
    await expect(summary.getByRole("button", { name: "Copy" })).toBeVisible({ timeout: 3000 });
  });
});
