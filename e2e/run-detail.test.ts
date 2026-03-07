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
  {
    kind: "assistant_text",
    iteration: 1,
    text: "Working on the fix...",
    _ts: 1741336205000,
  },
  {
    kind: "iteration_complete",
    iteration: 1,
    result: { total_cost_usd: 0.1523 },
    _ts: 1741336230000,
  },
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
    await expect(
      summary.getByText("sess-abc-123", { exact: true }),
    ).toBeVisible();
  });

  test("Copy button is visible next to session ID", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetail(page, mockTauri);

    // There should be a "Copy" button within the summary section, near the session ID
    const summary = page.locator(".summary");
    await expect(summary).toBeVisible();

    const copyButton = summary.getByRole("button", { name: "Copy" });
    await expect(copyButton).toBeVisible();
  });

  test("Copy button shows 'Copied!' feedback after click", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetail(page, mockTauri);

    // Mock navigator.clipboard.writeText to capture the written value
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__clipboardWritten = null;
      if (!navigator.clipboard) {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async (text: string) => {
              (
                window as unknown as Record<string, unknown>
              ).__clipboardWritten = text;
            },
          },
          writable: true,
        });
      } else {
        navigator.clipboard.writeText = async (text: string) => {
          (window as unknown as Record<string, unknown>).__clipboardWritten =
            text;
        };
      }
    });

    const summary = page.locator(".summary");
    const copyButton = summary.getByRole("button", { name: "Copy" });
    await expect(copyButton).toBeVisible();

    // Click the Copy button
    await copyButton.click();

    // Verify the correct session ID was written to the clipboard
    const written = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__clipboardWritten,
    );
    expect(written).toBe("sess-abc-123");

    // Button text should change to "Copied!"
    await expect(
      summary.getByRole("button", { name: "Copied!" }),
    ).toBeVisible();

    // After 1.5 seconds, it should revert back to "Copy"
    await expect(summary.getByRole("button", { name: "Copy" })).toBeVisible({
      timeout: 3000,
    });
  });
});

// ---------------------------------------------------------------------------
// Iteration groups with enriched token data
// ---------------------------------------------------------------------------

const ENRICHED_EVENTS = [
  { kind: "session_started", session_id: "sess-abc-123", _ts: 1741336200000 },
  { kind: "iteration_started", iteration: 1, _ts: 1741336201000 },
  {
    kind: "assistant_text",
    iteration: 1,
    text: "Analyzing the code...",
    _ts: 1741336205000,
  },
  { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741336210000 },
  {
    kind: "iteration_complete",
    iteration: 1,
    result: {
      total_cost_usd: 0.1523,
      input_tokens: 30000,
      output_tokens: 3200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 2000,
      context_window: 200000,
    },
    _ts: 1741336230000,
  },
  { kind: "iteration_started", iteration: 2, _ts: 1741336231000 },
  {
    kind: "assistant_text",
    iteration: 2,
    text: "Implementing the fix...",
    _ts: 1741336235000,
  },
  { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741336240000 },
  {
    kind: "iteration_complete",
    iteration: 2,
    result: {
      total_cost_usd: 0.1612,
      input_tokens: 62000,
      output_tokens: 4500,
      cache_read_input_tokens: 18000,
      cache_creation_input_tokens: 3000,
      context_window: 200000,
    },
    _ts: 1741336260000,
  },
  { kind: "session_complete", outcome: "completed", _ts: 1741336335000 },
];

const ENRICHED_TRACE = {
  session_id: "sess-abc-123",
  repo_path: "/home/user/repos/my-project",
  repo_id: "repo-1",
  prompt: "Fix login bug",
  plan_file: "plans/fix-login.md",
  start_time: "2026-03-07T08:30:00Z",
  end_time: "2026-03-07T08:42:15Z",
  outcome: "completed",
  failure_reason: null,
  total_iterations: 2,
  total_cost_usd: 0.3135,
  total_input_tokens: 92000,
  total_output_tokens: 7700,
  total_cache_read_tokens: 23000,
  total_cache_creation_tokens: 5000,
};

async function navigateToRunDetailWithEnrichedEvents(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
) {
  await mockTauri({
    storeData: {
      repos: [REPO_FIXTURE],
    },
    invokeHandlers: {
      list_traces: () => [ENRICHED_TRACE],
      get_trace: () => ENRICHED_TRACE,
      get_trace_events: () => ENRICHED_EVENTS,
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

test.describe("RunDetail — iteration groups with token data", () => {
  test("iteration group shows token counts", async ({ page, mockTauri }) => {
    await navigateToRunDetailWithEnrichedEvents(page, mockTauri);

    // Iteration 1 header should display input/output token counts
    const iter1Header = page.locator(".iteration-header", {
      hasText: "Iteration 1",
    });
    await expect(iter1Header).toBeVisible();
    // The stats format is: "30,000 in / 3,200 out"
    await expect(iter1Header.locator(".iteration-stats")).toContainText(
      "30,000 in",
    );
    await expect(iter1Header.locator(".iteration-stats")).toContainText(
      "3,200 out",
    );

    // Iteration 2 header should display its token counts
    const iter2Header = page.locator(".iteration-header", {
      hasText: "Iteration 2",
    });
    await expect(iter2Header).toBeVisible();
    await expect(iter2Header.locator(".iteration-stats")).toContainText(
      "62,000 in",
    );
    await expect(iter2Header.locator(".iteration-stats")).toContainText(
      "4,500 out",
    );
  });

  test("context bar appears when context_window data exists", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetailWithEnrichedEvents(page, mockTauri);

    // Both iteration groups should have a context bar since context_window > 0
    const contextBars = page.locator(".context-bar");
    await expect(contextBars).toHaveCount(2);

    // Each context bar should be visible
    await expect(contextBars.first()).toBeVisible();
    await expect(contextBars.last()).toBeVisible();
  });

  test("context bar shows correct percentage", async ({ page, mockTauri }) => {
    await navigateToRunDetailWithEnrichedEvents(page, mockTauri);

    // Iteration 1: input_tokens=30000, context_window=200000 → 15%
    // Label format: "30k / 200k (15%)"
    const iter1Group = page.locator(".iteration-group").first();
    const iter1Bar = iter1Group.locator(".context-bar");
    await expect(iter1Bar.locator(".context-bar-label")).toContainText(
      "30k / 200k (15%)",
    );

    // Iteration 2: input_tokens=62000, context_window=200000 → 31%
    // Label format: "62k / 200k (31%)"
    const iter2Group = page.locator(".iteration-group").nth(1);
    const iter2Bar = iter2Group.locator(".context-bar");
    await expect(iter2Bar.locator(".context-bar-label")).toContainText(
      "62k / 200k (31%)",
    );
  });
});
