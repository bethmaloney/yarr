import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const localRepo = {
  type: "local" as const,
  id: "local-repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
};

async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  repo: Record<string, unknown> = localRepo,
  invokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({
    storeData: { repos: [repo] },
    invokeHandlers: {
      get_active_sessions: () => [],
      list_plans: () => ["feature.md"],
      ...invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

async function openConfigSheet(page: import("@playwright/test").Page) {
  await page.locator(".settings").click();
  await page
    .locator('[data-slot="sheet-content"]')
    .waitFor({ state: "visible" });
}

function sheetContent(page: import("@playwright/test").Page) {
  return page.locator('[data-slot="sheet-content"]');
}

async function selectPlanFile(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Select a plan" }).click();
  await page.getByRole("option", { name: "feature.md" }).click();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test.describe("Remove Repository button", () => {
  // -------------------------------------------------------------------------
  // 1. Remove button is visible in settings sheet footer
  // -------------------------------------------------------------------------
  test("remove button is visible in settings sheet footer with Trash2 icon", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const removeBtn = sheet.getByTestId("remove-repo");

    await expect(removeBtn).toBeVisible();
    await expect(removeBtn).toContainText("Remove");

    // Verify the Trash2 icon is present (Lucide renders an SVG)
    await expect(removeBtn.locator("svg")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. Remove button is disabled when session is running
  // -------------------------------------------------------------------------
  test("remove button is disabled when session is running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
      run_session: () => ({ session_id: "sess-123" }),
    });

    // Start a session
    await selectPlanFile(page);
    await page.getByRole("button", { name: "Run" }).click();
    await expect(
      page.getByRole("button", { name: "Running..." }),
    ).toBeVisible();

    // Now open config sheet and check remove button is disabled
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const removeBtn = sheet.getByTestId("remove-repo");

    await expect(removeBtn).toBeVisible();
    await expect(removeBtn).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 3. Remove button navigates home after confirmation
  // -------------------------------------------------------------------------
  test("remove button navigates home after confirmation", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const removeBtn = sheet.getByTestId("remove-repo");

    // plugin:dialog|ask returns true by default, so clicking will confirm
    await removeBtn.click();

    // Verify navigation to home
    await page.waitForURL("/");

    // Verify success toast
    const toast = page.locator("[data-sonner-toast]", {
      hasText: "Repository removed",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  // -------------------------------------------------------------------------
  // 4. Remove button does nothing when dialog is cancelled
  // -------------------------------------------------------------------------
  test("remove button does nothing when dialog is cancelled", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
      "plugin:dialog|ask": () => false,
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const removeBtn = sheet.getByTestId("remove-repo");

    await removeBtn.click();

    // Page should stay on the repo detail — h1 still shows the repo name
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Sheet should still be open
    await expect(sheet).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Dashboard card remove button
// ---------------------------------------------------------------------------
test.describe("RepoCard hover remove button", () => {
  // -------------------------------------------------------------------------
  // 1. Remove button appears on RepoCard hover
  // -------------------------------------------------------------------------
  test("remove button appears on RepoCard hover", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [localRepo] } });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await expect(card).toBeVisible();

    // The remove button should not be visible before hover
    const removeBtn = card.getByLabel("Remove repository");
    await expect(removeBtn).toBeHidden();

    // Hover over the card to reveal the remove button
    await card.hover();
    await expect(removeBtn).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. Clicking remove button on card shows confirmation and removes repo
  // -------------------------------------------------------------------------
  test("clicking remove button on card shows confirmation and removes repo", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [localRepo] } });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await card.hover();

    const removeBtn = card.getByLabel("Remove repository");
    await removeBtn.click();

    // Should stay on the Home page
    await expect(page).toHaveURL("/");

    // Verify success toast
    const toast = page.locator("[data-sonner-toast]", {
      hasText: "Repository removed",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Verify the repo card is no longer visible
    await expect(card).toBeHidden();
  });

  // -------------------------------------------------------------------------
  // 3. Clicking remove button does nothing when dialog is cancelled
  // -------------------------------------------------------------------------
  test("clicking remove button does nothing when dialog is cancelled", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [localRepo] },
      invokeHandlers: {
        "plugin:dialog|ask": () => false,
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await card.hover();

    const removeBtn = card.getByLabel("Remove repository");
    await removeBtn.click();

    // The repo card should still be visible
    await expect(card).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 4. Remove button click does not navigate to repo detail
  // -------------------------------------------------------------------------
  test("remove button click does not navigate to repo detail", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [localRepo] } });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await card.hover();

    const removeBtn = card.getByLabel("Remove repository");
    await removeBtn.click();

    // After confirming removal, the URL should still be "/" (Home), not "/repo/local-repo-1"
    await expect(page).toHaveURL("/");

    // Verify we did NOT navigate to the repo detail page
    await expect(
      page.locator("h1", { hasText: "my-app" }),
    ).not.toBeVisible();
  });
});
