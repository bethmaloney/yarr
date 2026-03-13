import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const repoStoreData = {
  repos: [
    {
      id: "repo-1",
      path: "/home/user/projects/my-app",
      name: "my-app",
      model: "opus",
      effortLevel: "medium",
      designEffortLevel: "high",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    },
  ],
};

// ---------------------------------------------------------------------------
// Helper: navigate to the RepoDetail page for "my-app"
// ---------------------------------------------------------------------------
async function navigateToRepoDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  extra?: {
    invokeHandlers?: Record<string, unknown>;
    storeData?: Record<string, unknown>;
  },
) {
  await mockTauri({
    storeData: { ...repoStoreData, ...extra?.storeData },
    invokeHandlers: {
      get_active_sessions: () => [],
      run_oneshot: () => new Promise(() => {}),
      ...extra?.invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Helper: open the settings sheet on the RepoDetail page
// ---------------------------------------------------------------------------
async function openConfigSheet(page: import("@playwright/test").Page) {
  await page.locator(".settings").click();
  // Wait for the sheet to be visible (it renders in a portal)
  await page
    .locator('[data-slot="sheet-content"]')
    .waitFor({ state: "visible" });
}

// The sheet content locator (Sheet renders in a portal, not under .settings)
function sheetContent(page: import("@playwright/test").Page) {
  return page.locator('[data-slot="sheet-content"]');
}

// ---------------------------------------------------------------------------
// Helper: open the inline 1-shot form on the RepoDetail page
// ---------------------------------------------------------------------------
async function openOneShotForm(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  extra?: {
    invokeHandlers?: Record<string, unknown>;
    storeData?: Record<string, unknown>;
  },
) {
  await navigateToRepoDetail(page, mockTauri, extra);
  await page.getByRole("button", { name: "1-Shot" }).click();
  await expect(page.locator("#oneshot-title")).toBeVisible();
}

// ---------------------------------------------------------------------------
// 1. Ralph settings effort dropdown
// ---------------------------------------------------------------------------
test.describe("Ralph settings effort level", () => {
  test("effort level select exists in settings with default medium", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);
    await openConfigSheet(page);

    // The Effort Level label should be visible in the settings tab
    await expect(sheetContent(page).getByText("Effort Level")).toBeVisible();

    // The select trigger should show "medium" as the default value
    const effortTrigger = sheetContent(page)
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await expect(effortTrigger).toBeVisible();
  });

  test("effort level select can be changed to other values", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);
    await openConfigSheet(page);

    // Click the effort level select trigger to open the dropdown
    const effortTrigger = sheetContent(page)
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await effortTrigger.click();

    // Select "high" from the dropdown
    await page.getByRole("option", { name: "high" }).click();

    // Verify the select now shows "high"
    await expect(
      sheetContent(page)
        .locator('[data-slot="select-trigger"]')
        .filter({ hasText: "high" }),
    ).toBeVisible();
  });

  test("effort level select shows all valid options", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);
    await openConfigSheet(page);

    // Click the effort level select trigger to open the dropdown
    const effortTrigger = sheetContent(page)
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await effortTrigger.click();

    // All four effort levels should be available as options
    await expect(page.getByRole("option", { name: "low" })).toBeVisible();
    await expect(page.getByRole("option", { name: "medium" })).toBeVisible();
    await expect(page.getByRole("option", { name: "high" })).toBeVisible();
    await expect(page.getByRole("option", { name: "max" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 2. Oneshot form effort dropdowns
// ---------------------------------------------------------------------------
test.describe("Oneshot form effort dropdowns", () => {
  test("design and implementation effort level selects are visible", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    await expect(page.getByText("Design Effort Level")).toBeVisible();
    await expect(page.getByText("Implementation Effort Level")).toBeVisible();
  });

  test("design effort level defaults to high", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    // The design effort select trigger should show "high"
    const designTrigger = page
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "high" });
    await expect(designTrigger).toBeVisible();
  });

  test("implementation effort level defaults to medium", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    // The implementation effort select trigger should show "medium"
    const implTrigger = page
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await expect(implTrigger).toBeVisible();
  });

  test("effort levels are passed to run_oneshot on launch", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri, {
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedArgs = args;
          return { oneshot_id: "oneshot-effort-1", trace: null };
        },
      },
    });

    await page.locator("#oneshot-title").fill("Effort test");
    await page.locator("#oneshot-prompt").fill("Test effort levels");

    // Change design effort to "max" by clicking the design effort trigger
    // The design effort trigger shows "high" by default
    const designTrigger = page
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "high" });
    await designTrigger.click();
    await page.getByRole("option", { name: "max" }).click();

    // Change implementation effort to "low" by clicking the impl trigger
    // The impl effort trigger shows "medium" by default
    const implTrigger = page
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await implTrigger.click();
    await page.getByRole("option", { name: "low" }).click();

    await page.getByRole("button", { name: "Launch" }).click();

    const captured = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__capturedArgs,
    );

    expect(captured).toBeTruthy();
    const args = captured as Record<string, unknown>;
    expect(args.effortLevel).toBe("low");
    expect(args.designEffortLevel).toBe("max");
  });
});

// ---------------------------------------------------------------------------
// 3. Effort level persists to repo config
// ---------------------------------------------------------------------------
test.describe("Effort level persistence", () => {
  test("changed effort level persists after save and re-navigate", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);
    await openConfigSheet(page);

    // Default should be "medium"
    const effortTrigger = sheetContent(page)
      .locator('[data-slot="select-trigger"]')
      .filter({ hasText: "medium" });
    await expect(effortTrigger).toBeVisible();

    // Change to "high"
    await effortTrigger.click();
    await page.getByRole("option", { name: "high" }).click();

    // Save settings
    await page.getByRole("button", { name: "Save" }).click();

    // Navigate away by clicking the "Home" breadcrumb
    await page
      .locator(".breadcrumbs")
      .getByRole("button", { name: "Home" })
      .click();

    // Navigate back to the repo
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Open config sheet again and verify the effort level is still "high"
    await openConfigSheet(page);
    await expect(
      sheetContent(page)
        .locator('[data-slot="select-trigger"]')
        .filter({ hasText: "high" }),
    ).toBeVisible();
  });

  test("repo with effortLevel set to max shows max in settings", async ({
    page,
    mockTauri,
  }) => {
    const repoWithMaxEffort = {
      repos: [
        {
          id: "repo-1",
          path: "/home/user/projects/my-app",
          name: "my-app",
          model: "opus",
          effortLevel: "max",
          designEffortLevel: "high",
          maxIterations: 40,
          completionSignal: "ALL TODO ITEMS COMPLETE",
        },
      ],
    };

    await mockTauri({
      storeData: repoWithMaxEffort,
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    await openConfigSheet(page);

    await expect(
      sheetContent(page)
        .locator('[data-slot="select-trigger"]')
        .filter({ hasText: "max" }),
    ).toBeVisible();
  });
});
