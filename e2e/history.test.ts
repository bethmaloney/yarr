import { test, expect } from "./fixtures";

const REPO_CONFIG = {
  repos: [
    {
      id: "repo-1",
      path: "/home/user/repos/my-project",
      name: "my-project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    },
  ],
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
  },
  {
    session_id: "sess-def-456",
    repo_path: "/home/user/repos/my-project",
    repo_id: "repo-1",
    prompt: "Refactor auth module to use JWT tokens with refresh rotation",
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
  },
];

async function navigateToHistory(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: import("./fixtures").TauriMockOptions) => Promise<void>,
  traces: unknown[] = SAMPLE_TRACES,
) {
  await mockTauri({
    storeData: REPO_CONFIG,
    invokeHandlers: {
      list_traces: traces,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator("h1", { hasText: "History" })).toBeVisible();
}

test.describe("History view — column headers (Task 9)", () => {
  test("header row exists with all column labels", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const header = page.locator(".trace-header");
    await expect(header).toBeVisible();

    await expect(header).toContainText("Date");
    await expect(header).toContainText("Plan");
    await expect(header).toContainText("Prompt");
    await expect(header).toContainText("Status");
    await expect(header).toContainText("Iters");
    await expect(header).toContainText("Cost");
    await expect(header).toContainText("Duration");
  });

  test("header row appears above trace rows", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const traceList = page.locator(".trace-list");
    await expect(traceList).toBeVisible();

    // The header should be a child of .trace-list and come before any .trace-row
    const children = traceList.locator("> *");
    const firstChild = children.first();
    await expect(firstChild).toHaveClass(/trace-header/);

    // Trace rows should follow the header
    const traceRows = traceList.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);
  });

  test("header row is not shown when there are no traces", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri, []);

    // With no traces, the empty state should show and no header should be present
    await expect(page.getByText("No runs recorded yet.")).toBeVisible();
    await expect(page.locator(".trace-header")).toHaveCount(0);
  });
});

test.describe("History view — prompt text column (Task 10)", () => {
  test("prompt text is visible in each trace row", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // First row should contain the prompt text
    const firstRowPrompt = traceRows.nth(0).locator(".trace-prompt");
    await expect(firstRowPrompt).toBeVisible();
    await expect(firstRowPrompt).toContainText("Fix login bug");

    // Second row should contain its prompt text
    const secondRowPrompt = traceRows.nth(1).locator(".trace-prompt");
    await expect(secondRowPrompt).toBeVisible();
    await expect(secondRowPrompt).toContainText("Refactor auth module");
  });

  test("prompt span has the trace-prompt class", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const promptSpans = page.locator(".trace-row .trace-prompt");
    await expect(promptSpans).toHaveCount(2);
  });

  test("prompt column appears between plan and status badge", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const firstRow = page.locator(".trace-row").first();

    // Get all span children within the row to verify ordering
    const spans = firstRow.locator("span");
    const spanClasses: string[] = [];
    const count = await spans.count();
    for (let i = 0; i < count; i++) {
      const cls = await spans.nth(i).getAttribute("class");
      if (cls) spanClasses.push(cls);
    }

    // Find indices of plan, prompt, and badge
    const planIndex = spanClasses.findIndex((c) => c.includes("trace-plan"));
    const promptIndex = spanClasses.findIndex((c) => c.includes("trace-prompt"));
    const badgeIndex = spanClasses.findIndex((c) => c.includes("trace-badge"));

    // Prompt should come after plan and before badge
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(badgeIndex).toBeGreaterThanOrEqual(0);
    expect(promptIndex).toBeGreaterThan(planIndex);
    expect(promptIndex).toBeLessThan(badgeIndex);
  });

  test("prompt text in header row matches column position", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    // The header should also contain a "Prompt" label
    const header = page.locator(".trace-header");
    await expect(header).toContainText("Prompt");
  });
});
