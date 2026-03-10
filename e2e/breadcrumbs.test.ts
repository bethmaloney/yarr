import { test, expect } from "./fixtures";

const REPO_FIXTURE = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

const TRACE_FIXTURE = {
  session_id: "sess-abc123",
  repo_id: "repo-1",
  repo_path: "/home/user/projects/my-app",
  plan_file: "docs/plan.md",
  model: "opus",
  outcome: "completed",
  total_iterations: 3,
  total_cost_usd: 0.1234,
  total_input_tokens: 1000,
  total_output_tokens: 500,
  start_time: "2026-03-01T10:00:00Z",
  end_time: "2026-03-01T10:05:00Z",
};

test.describe("Breadcrumb navigation", () => {
  test("Home view shows a single non-clickable 'Home' breadcrumb", async ({
    tauriPage: page,
  }) => {
    const nav = page.locator(".breadcrumbs");
    await expect(nav).toBeVisible();

    // "Home" should be the current (last) crumb, rendered as a span
    await expect(nav.locator('[aria-current="page"]')).toHaveText("Home");

    // No clickable breadcrumb links should exist on the home view
    await expect(nav.locator('[data-slot="breadcrumb-link"]')).toHaveCount(0);
  });

  test("RepoDetail shows 'Home / my-app' breadcrumbs", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
    });
    await page.goto("/");

    // Navigate to repo detail
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    const nav = page.locator(".breadcrumbs");
    await expect(nav).toBeVisible();

    // "Home" should be a clickable button
    await expect(nav.getByRole("button", { name: "Home" })).toBeVisible();

    // "my-app" should be the current (last) crumb, not clickable
    await expect(nav.locator('[aria-current="page"]')).toHaveText("my-app");

    // Separator should be present (ChevronRight icon via BreadcrumbSeparator)
    await expect(nav.locator('[data-slot="breadcrumb-separator"]')).toBeVisible();
  });

  test("Clicking 'Home' breadcrumb in RepoDetail navigates back to home", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
    });
    await page.goto("/");

    // Navigate to repo detail
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Click the "Home" breadcrumb button
    const nav = page.locator(".breadcrumbs");
    await nav.getByRole("button", { name: "Home" }).click();

    // Verify we are back on the home view
    await expect(page.locator("h1", { hasText: "Yarr" })).toBeVisible();
  });

  test("HistoryView shows 'Home / History' breadcrumbs", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
    });
    await page.goto("/");

    // Navigate to history via the toolbar button
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

    const nav = page.locator(".breadcrumbs");
    await expect(nav).toBeVisible();

    // "Home" should be a clickable button
    await expect(nav.getByRole("button", { name: "Home" })).toBeVisible();

    // "History" should be the current (last) crumb
    await expect(nav.locator('[aria-current="page"]')).toHaveText("History");
  });

  test("No .back-btn elements exist on RepoDetail", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
    });
    await page.goto("/");

    // Navigate to repo detail
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    await expect(page.locator(".back-btn")).toHaveCount(0);
  });

  test("No .back-btn elements exist on HistoryView", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
    });
    await page.goto("/");

    // Navigate to history
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

    await expect(page.locator(".back-btn")).toHaveCount(0);
  });

  test("No .back-btn elements exist on RunDetail", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [REPO_FIXTURE],
      },
      invokeHandlers: {
        list_traces: [TRACE_FIXTURE],
        get_trace: TRACE_FIXTURE,
        get_trace_events: [],
      },
    });
    await page.goto("/");

    // Navigate to history, then to a run detail
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

    // Click the trace row to navigate to run detail
    await page.locator(".trace-row").first().click();
    await expect(page.locator("h1", { hasText: "Run Detail" })).toBeVisible();

    await expect(page.locator(".back-btn")).toHaveCount(0);
  });
});
