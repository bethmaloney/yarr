import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const localRepo = {
  type: "local" as const,
  id: "local-repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

const sshRepo = {
  type: "ssh" as const,
  id: "ssh-repo-1",
  sshHost: "dev-server",
  remotePath: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  repo: Record<string, unknown> = localRepo,
) {
  await mockTauri({ storeData: { repos: [repo] } });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

async function openConfigSheet(page: import("@playwright/test").Page) {
  await page.locator(".settings").click();
}

async function startRunningSession(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
) {
  await mockTauri({
    storeData: { repos: [localRepo] },
    invokeHandlers: {
      run_session: () => new Promise(() => {}),
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
  await page
    .getByPlaceholder("docs/plans/my-feature-design.md")
    .fill("/tmp/plan.md");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await expect(page.getByText("Running...")).toBeVisible();
}

test.describe("Auto-fetch toggle", () => {
  test("local repo shows auto-fetch checked by default", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri);
    await openConfigSheet(page);

    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeVisible();
    await expect(autoFetchCheckbox).toBeChecked();
  });

  test("SSH repo shows auto-fetch unchecked by default", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, sshRepo);
    await openConfigSheet(page);

    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeVisible();
    await expect(autoFetchCheckbox).not.toBeChecked();
  });

  test("auto-fetch toggle disabled during running session", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);
    await openConfigSheet(page);

    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeVisible();
    await expect(autoFetchCheckbox).toBeDisabled();
  });

  test("toggling auto-fetch off persists on save", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri);
    await openConfigSheet(page);

    // Verify it starts checked (local repo default)
    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeChecked();

    // Uncheck it
    await autoFetchCheckbox.click();
    await expect(autoFetchCheckbox).not.toBeChecked();

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

    // Open config sheet again and verify it's still unchecked
    await openConfigSheet(page);
    const autoFetchAfter = page.locator("#auto-fetch");
    await expect(autoFetchAfter).not.toBeChecked();
  });

  test("repo with autoFetch explicitly set to true shows checked", async ({
    page,
    mockTauri,
  }) => {
    const repoWithAutoFetchTrue = {
      ...localRepo,
      autoFetch: true,
    };

    await navigateToRepo(page, mockTauri, repoWithAutoFetchTrue);
    await openConfigSheet(page);

    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeVisible();
    await expect(autoFetchCheckbox).toBeChecked();
  });

  test("repo with autoFetch explicitly set to false shows unchecked", async ({
    page,
    mockTauri,
  }) => {
    const repoWithAutoFetchFalse = {
      ...localRepo,
      autoFetch: false,
    };

    await navigateToRepo(page, mockTauri, repoWithAutoFetchFalse);
    await openConfigSheet(page);

    const autoFetchCheckbox = page.locator("#auto-fetch");
    await expect(autoFetchCheckbox).toBeVisible();
    await expect(autoFetchCheckbox).not.toBeChecked();
  });
});
