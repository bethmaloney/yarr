import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const REPO = {
  id: "repo-1",
  path: "/home/user/repos/my-project",
  name: "my-project",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

const SAMPLE_TRACES = [
  {
    session_id: "sess-abc-123",
    repo_path: "/home/user/repos/my-project",
    repo_id: "repo-1",
    prompt: "Fix login bug and add tests for authentication flow",
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
    session_type: "ralph_loop",
  },
  {
    session_id: "sess-def-456",
    repo_path: "/home/user/repos/my-project",
    repo_id: "repo-1",
    prompt: "Refactor auth module to use JWT tokens",
    plan_file: "plans/refactor-auth.md",
    start_time: "2026-03-06T14:10:00Z",
    end_time: "2026-03-06T14:25:30Z",
    outcome: "failed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 0.8912,
    total_input_tokens: 89000,
    total_output_tokens: 24000,
    total_cache_read_tokens: 12000,
    total_cache_creation_tokens: 5000,
    session_type: "ralph_loop",
  },
];

async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  invokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({
    storeData: { repos: [REPO] },
    invokeHandlers,
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-project/ }).click();
  await expect(page.locator("h1", { hasText: "my-project" })).toBeVisible();
}

test.describe("RepoDetail — History tab", () => {
  test("Session tab is active by default", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri);

    const sessionTab = page.getByRole("tab", { name: /Session/ });
    await expect(sessionTab).toHaveAttribute("data-state", "active");

    const historyTab = page.getByRole("tab", { name: /History/ });
    await expect(historyTab).toHaveAttribute("data-state", "inactive");
  });

  test("History tab shows trace data", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      list_traces: SAMPLE_TRACES,
    });

    // Click the History tab
    await page.getByRole("tab", { name: /History/ }).click();

    // Wait for trace rows to appear
    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // Verify trace content is displayed
    await expect(traceRows.nth(0)).toContainText("fix login");
    await expect(traceRows.nth(1)).toContainText("refactor auth");
  });

  test("History tab shows empty state when no traces exist", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, {
      list_traces: [],
    });

    // Click the History tab
    await page.getByRole("tab", { name: /History/ }).click();

    // Verify empty state message
    await expect(page.getByText("No runs recorded yet")).toBeVisible();

    // No trace rows should be present
    await expect(page.locator(".trace-row")).toHaveCount(0);
  });

  test("History tab shows trace count badge after loading", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, {
      list_traces: SAMPLE_TRACES,
    });

    // Click the History tab to trigger loading
    await page.getByRole("tab", { name: /History/ }).click();

    // Wait for traces to load, then verify the tab trigger shows the count
    const historyTab = page.getByRole("tab", { name: /History/ });
    await expect(historyTab).toContainText("(2)");
  });
});
