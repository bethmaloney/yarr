import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

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
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  invokeHandlers?: Record<string, unknown>,
) {
  await mockTauri({
    storeData: repoStoreData,
    invokeHandlers: {
      get_active_sessions: () => [],
      run_oneshot: () => null,
      ...invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

test.describe("1-Shot navigation", () => {
  test('"1-Shot" button is visible on repo detail page', async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    await expect(
      page.getByRole("button", { name: "1-Shot" }),
    ).toBeVisible();
  });

  test('clicking "1-Shot" navigates to the OneShotView', async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    await page.getByRole("button", { name: "1-Shot" }).click();

    // OneShotView should show the h1 with "1-Shot" text
    await expect(
      page.locator("h1", { hasText: "1-Shot" }),
    ).toBeVisible();

    // The form should have Title and Prompt inputs
    await expect(page.getByText("Title")).toBeVisible();
    await expect(page.getByText("Prompt")).toBeVisible();

    // The "Run" button should be present
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
  });

  test("back navigation from OneShotView returns to home view", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    // Navigate to 1-Shot view
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(
      page.locator("h1", { hasText: "1-Shot" }),
    ).toBeVisible();

    // Click the "Home" breadcrumb link to go back
    await page.getByText("Home").click();

    // Should return to the home view
    await expect(page.locator("h1", { hasText: "Yarr" })).toBeVisible();
  });

  test("OneShotView shows correct repo name", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    await page.getByRole("button", { name: "1-Shot" }).click();

    // The h1 should contain the repo name
    await expect(
      page.locator("h1", { hasText: "my-app" }),
    ).toBeVisible();

    // The full heading should be "{repo.name} — 1-Shot"
    await expect(
      page.locator("h1"),
    ).toContainText("my-app");
  });
});
