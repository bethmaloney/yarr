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

    const details = page.locator("details");
    await expect(details).toBeVisible();
    // Should be closed by default (no open attribute)
    await expect(details).not.toHaveAttribute("open", "");
    // Summary should display model and iteration count
    const summary = details.locator("summary");
    await expect(summary).toContainText("Settings");
    await expect(summary).toContainText("opus");
    await expect(summary).toContainText("40 iters");
  });

  test("settings can be expanded by clicking summary", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    const details = page.locator("details");
    const summary = details.locator("summary");
    await summary.click();

    // After clicking, the details should be open and the model input visible
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByRole("textbox", { name: /model/i })).toBeVisible();
  });

  test("no recents dropdown present", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    // There should be no <select> element on the repo detail page
    await expect(page.locator("select")).toHaveCount(0);
  });

  test("'Test Run' button visible instead of 'Mock'", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    // "Test Run" should be present
    await expect(page.getByRole("button", { name: "Test Run" })).toBeVisible();
    // "Mock" should not be present
    await expect(page.getByRole("button", { name: "Mock" })).not.toBeVisible();
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

  test("shows plan file preview when prompt file is entered", async ({ page, mockTauri }) => {
    const previewContent = "# Fix Login Bug\n\nImplement the fix for the login timeout issue.\n\n## Steps";
    await navigateToRepoDetailWithHandlers(page, mockTauri, {
      read_file_preview: previewContent,
    });

    // Fill in the prompt file input
    await page.getByPlaceholder("docs/plans/my-feature-design.md").fill("docs/plans/fix-login.md");

    // Wait for the preview to appear in a <pre> element
    const preview = page.locator("pre");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("# Fix Login Bug");
    await expect(preview).toContainText("Implement the fix for the login timeout issue.");
    await expect(preview).toContainText("## Steps");
  });

  test("hides preview when prompt file is cleared", async ({ page, mockTauri }) => {
    const previewContent = "# Fix Login Bug\n\nImplement the fix for the login timeout issue.\n\n## Steps";
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

  test("no preview shown when plan file is empty", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    // Without filling in the prompt file input, no <pre> preview should exist
    const planSection = page.locator(".plan-section");
    await expect(planSection).toBeVisible();
    await expect(planSection.locator("pre")).toHaveCount(0);
  });
});
