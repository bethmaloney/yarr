import { test, expect } from "./fixtures";

test.describe("Home view", () => {
  test("shows empty state when no repos configured", async ({
    tauriPage: page,
  }) => {
    await expect(page.getByText("No repos configured yet.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "+ Add repo" }),
    ).toBeVisible();
  });

  test("shows repo cards when repos exist", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: {
        repos: [
          {
            id: "repo-1",
            path: "/home/user/projects/my-app",
            name: "my-app",
            model: "opus",
            maxIterations: 40,
            completionSignal: "ALL TODO ITEMS COMPLETE",
          },
          {
            id: "repo-2",
            path: "/home/user/projects/api-server",
            name: "api-server",
            model: "sonnet",
            maxIterations: 20,
            completionSignal: "DONE",
          },
        ],
      },
    });
    await page.goto("/");

    await expect(page.getByRole("button", { name: /my-app/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /api-server/ }),
    ).toBeVisible();
    await expect(page.getByText("No repos configured yet.")).not.toBeVisible();
  });

  test("shows last run summary on repo card", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: {
        repos: [
          {
            id: "repo-1",
            path: "/home/user/projects/my-app",
            name: "my-app",
            model: "opus",
            maxIterations: 40,
            completionSignal: "ALL TODO ITEMS COMPLETE",
          },
        ],
      },
      invokeHandlers: {
        list_latest_traces: () => ({
          "repo-1": {
            session_id: "sess-abc-123",
            repo_path: "/home/user/projects/my-app",
            repo_id: "repo-1",
            prompt: "Fix login bug",
            plan_file: "plans/fix-login.md",
            start_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
            end_time: new Date(Date.now() - 1.8 * 60 * 60 * 1000).toISOString(),
            outcome: "completed",
            total_iterations: 3,
            total_cost_usd: 0.4521,
            total_input_tokens: 45200,
            total_output_tokens: 12350,
            total_cache_read_tokens: 8200,
            total_cache_creation_tokens: 3100,
          },
        }),
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("fix-login.md");
    await expect(card).toContainText("$0.45");
    await expect(card).toContainText("2h ago");
  });

  test("navigates to repo detail on card click", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        repos: [
          {
            id: "repo-1",
            path: "/home/user/projects/my-app",
            name: "my-app",
            model: "opus",
            maxIterations: 40,
            completionSignal: "ALL TODO ITEMS COMPLETE",
          },
        ],
      },
    });
    await page.goto("/");

    await page.getByRole("button", { name: /my-app/ }).click();
    // RepoDetail shows the repo name as h1 and the path
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await expect(page.getByText("/home/user/projects/my-app")).toBeVisible();
  });
});

test.describe("Repo detail page", () => {
  const repoStoreData = {
    repos: [
      {
        id: "repo-1",
        path: "/home/user/projects/my-app",
        name: "my-app",
        model: "opus",
        maxIterations: 40,
        completionSignal: "ALL TODO ITEMS COMPLETE",
      },
    ],
  };

  async function navigateToRepoDetail(
    page: import("@playwright/test").Page,
    mockTauri: (opts?: import("./fixtures").TauriMockOptions) => Promise<void>,
  ) {
    await mockTauri({ storeData: repoStoreData });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
  }

  test("settings collapsed by default with summary showing model and iterations", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    const section = page.locator(".settings");
    await expect(section).toBeVisible();
    // Should be closed by default
    await expect(section).toHaveAttribute("data-state", "closed");
    // Trigger should display model and iteration count
    const trigger = section.locator('[data-slot="collapsible-trigger"]');
    await expect(trigger).toContainText("Settings");
    await expect(trigger).toContainText("opus");
    await expect(trigger).toContainText("40 iters");
  });

  test("settings can be expanded by clicking summary", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    const section = page.locator(".settings");
    const trigger = section.locator('[data-slot="collapsible-trigger"]');
    await trigger.click();

    // After clicking, the section should be open and the model input visible
    await expect(section).toHaveAttribute("data-state", "open");
    await expect(page.getByRole("textbox", { name: /model/i })).toBeVisible();
  });

  test("no recents dropdown present", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    // There should be no <select> element on the repo detail page
    await expect(page.locator("select")).toHaveCount(0);
  });

  test("hint text shown when no plan file is selected", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    // When planFile is empty and not running, a hint should be displayed
    await expect(
      page.getByText("Select a prompt file to start a run"),
    ).toBeVisible();

    // After filling in the prompt file, the hint should disappear
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("docs/plan.md");
    await expect(
      page.getByText("Select a prompt file to start a run"),
    ).not.toBeVisible();
  });

  async function navigateToRepoDetailWithHandlers(
    page: import("@playwright/test").Page,
    mockTauri: (opts?: import("./fixtures").TauriMockOptions) => Promise<void>,
    invokeHandlers: Record<string, unknown>,
  ) {
    await mockTauri({ storeData: repoStoreData, invokeHandlers });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
  }

  test("shows plan file preview when prompt file is entered", async ({
    page,
    mockTauri,
  }) => {
    const previewContent =
      "# Fix Login Bug\n\nImplement the fix for the login timeout issue.\n\n## Steps";
    await navigateToRepoDetailWithHandlers(page, mockTauri, {
      read_file_preview: previewContent,
    });

    // Fill in the prompt file input
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("docs/plans/fix-login.md");

    // Wait for the preview to appear in a <pre> element
    const preview = page.locator("pre");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("# Fix Login Bug");
    await expect(preview).toContainText(
      "Implement the fix for the login timeout issue.",
    );
    await expect(preview).toContainText("## Steps");
  });

  test("hides preview when prompt file is cleared", async ({
    page,
    mockTauri,
  }) => {
    const previewContent =
      "# Fix Login Bug\n\nImplement the fix for the login timeout issue.\n\n## Steps";
    await navigateToRepoDetailWithHandlers(page, mockTauri, {
      read_file_preview: previewContent,
    });

    // Fill in the prompt file input and verify preview appears
    const input = page.getByPlaceholder("docs/plans/my-feature-design.md");
    await input.fill("docs/plans/fix-login.md");
    const preview = page.locator("pre");
    await expect(preview).toBeVisible();

    // Clear the input and verify preview disappears
    await input.fill("");
    await expect(preview).not.toBeVisible();
  });

  test("no preview shown when plan file is empty", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    // Without filling in the prompt file input, no <pre> preview should exist
    const planSection = page.locator(".plan-section");
    await expect(planSection).toBeVisible();
    await expect(planSection.locator("pre")).toHaveCount(0);
  });
});

test.describe("Home page toolbar alignment", () => {
  test("title and History button are both visible", async ({
    tauriPage: page,
  }) => {
    await expect(page.locator("h1", { hasText: "Yarr" })).toBeVisible();
    await expect(page.getByRole("button", { name: "History" })).toBeVisible();
  });

  test("toolbar-header contains both title and buttons in a single row", async ({
    tauriPage: page,
  }) => {
    const toolbarHeader = page.locator(".toolbar-header");
    await expect(toolbarHeader).toBeVisible();

    // The single container should hold the h1 title
    await expect(toolbarHeader.locator("h1")).toContainText("Yarr");

    // The single container should hold the History button
    await expect(
      toolbarHeader.getByRole("button", { name: "History" }),
    ).toBeVisible();

    // The single container should hold the Add repo button
    await expect(
      toolbarHeader.getByRole("button", { name: "+ Add repo" }),
    ).toBeVisible();
  });

  test("subtitle is still visible", async ({ tauriPage: page }) => {
    await expect(
      page.locator(".subtitle", { hasText: "Claude Orchestrator" }),
    ).toBeVisible();
  });
});
