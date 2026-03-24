import { test, expect } from "./fixtures";

const REPO_CONFIG = {
  repos: [
    {
      id: "repo-1",
      path: "/home/user/repos/my-project",
      name: "my-project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "<promise>COMPLETE</promise>",
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
  test("header row exists with all column labels", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const header = page.locator(".trace-header");
    await expect(header).toBeVisible();

    await expect(header).toContainText("Date");
    await expect(header).toContainText("Description");
    await expect(header).toContainText("Status");
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

  test("header row is not shown when there are no traces", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri, []);

    // With no traces, the empty state should show and no header should be present
    await expect(page.getByText("No runs recorded yet.")).toBeVisible();
    await expect(page.locator(".trace-header")).toHaveCount(0);
  });
});

test.describe("History view — description column (Task 10)", () => {
  test("description text is visible in each trace row", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // Both sample traces are ralph loops with plan files, so description shows plan filename
    const firstRowDesc = traceRows.nth(0).locator(".trace-prompt");
    await expect(firstRowDesc).toBeVisible();
    await expect(firstRowDesc).toContainText("fix login");

    const secondRowDesc = traceRows.nth(1).locator(".trace-prompt");
    await expect(secondRowDesc).toBeVisible();
    await expect(secondRowDesc).toContainText("refactor auth");
  });

  test("description span has the trace-prompt class", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const descSpans = page.locator(".trace-row .trace-prompt");
    await expect(descSpans).toHaveCount(2);
  });

  test("description column appears before status badge", async ({
    page,
    mockTauri,
  }) => {
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

    // Find indices of description and badge
    const descIndex = spanClasses.findIndex((c) => c.includes("trace-prompt"));
    const badgeIndex = spanClasses.findIndex((c) => c.includes("trace-badge"));

    expect(descIndex).toBeGreaterThanOrEqual(0);
    expect(badgeIndex).toBeGreaterThanOrEqual(0);
    expect(descIndex).toBeLessThan(badgeIndex);
  });

  test("description text in header row matches column position", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const header = page.locator(".trace-header");
    await expect(header).toContainText("Description");
  });
});

test.describe("History view — sortable columns (Task 11)", () => {
  test("column headers are clickable buttons", async ({ page, mockTauri }) => {
    await navigateToHistory(page, mockTauri);

    const header = page.locator(".trace-header");
    await expect(header).toBeVisible();

    // Each sortable column should be a <button> element, not a <span>
    const headerButtons = header.locator("button");
    const expectedColumns = [
      "Date",
      "Type",
      "Description",
      "Status",
      "Duration",
    ];

    for (const label of expectedColumns) {
      const btn = header.locator("button", { hasText: label });
      await expect(btn).toBeVisible();
    }

    // There should be at least as many buttons as sortable columns
    await expect(headerButtons).toHaveCount(expectedColumns.length);
  });

  test("default sort is date descending — most recent trace first", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // sess-abc-123 (Mar 7) is more recent than sess-def-456 (Mar 6), so it should be first
    const firstRow = traceRows.nth(0);
    await expect(firstRow).toContainText("fix login");

    const secondRow = traceRows.nth(1);
    await expect(secondRow).toContainText("refactor auth");

    // The Date column header button should show a descending arrow indicator
    const dateButton = page.locator(".trace-header button", {
      hasText: "Date",
    });
    await expect(dateButton).toContainText("\u2193"); // down arrow
  });

  test("clicking Date header toggles to ascending sort", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    // Click the Date header button to toggle from desc to asc
    const dateButton = page.locator(".trace-header button", {
      hasText: "Date",
    });
    await dateButton.click();

    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // After toggling to ascending, the older trace (sess-def-456, Mar 6) should be first
    const firstRow = traceRows.nth(0);
    await expect(firstRow).toContainText("refactor auth");

    const secondRow = traceRows.nth(1);
    await expect(secondRow).toContainText("fix login");

    // Arrow should flip to ascending indicator
    await expect(dateButton).toContainText("\u2191"); // up arrow
  });

  test("clicking Duration header sorts by duration", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    // Click Duration header to sort by duration ascending
    const durationButton = page.locator(".trace-header button", {
      hasText: "Duration",
    });
    await durationButton.click();

    const traceRows = page.locator(".trace-row");
    await expect(traceRows).toHaveCount(2);

    // sess-abc-123 is 12m15s, sess-def-456 is 15m30s
    // Ascending: shorter first
    const firstRow = traceRows.nth(0);
    await expect(firstRow).toContainText("fix login");

    const secondRow = traceRows.nth(1);
    await expect(secondRow).toContainText("refactor auth");

    // Duration button should show the active sort arrow
    await expect(durationButton).toContainText("\u2191"); // ascending arrow
  });

  test("header buttons have no visible button chrome", async ({
    page,
    mockTauri,
  }) => {
    await navigateToHistory(page, mockTauri);

    const headerButtons = page.locator(".trace-header button");
    const count = await headerButtons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const btn = headerButtons.nth(i);

      // Buttons should have no border
      const border = await btn.evaluate(
        (el) => getComputedStyle(el).borderStyle,
      );
      expect(border).toBe("none");

      // Buttons should have cursor: pointer
      const cursor = await btn.evaluate((el) => getComputedStyle(el).cursor);
      expect(cursor).toBe("pointer");
    }
  });
});
