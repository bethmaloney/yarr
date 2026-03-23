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

/**
 * Navigate to the RepoDetail page with the given invoke handlers.
 * The `get_repo_git_status` handler is called by the Zustand store's `fetchGitStatus`
 * action, which is triggered by the `useGitStatus` hook on the Home page mount
 * and remains in the store when navigating to RepoDetail.
 */
async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  invokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({
    storeData: { repos: [localRepo] },
    invokeHandlers,
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

test.describe("RepoDetail git status from store", () => {
  test("shows dirty count in branch chip", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 3,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main"],
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
    await expect(chip).toContainText("3 dirty");
  });

  test("does not show dirty count when zero", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main"],
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
    await expect(chip).not.toContainText("dirty");
  });

  test("shows last checked timestamp", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main"],
    });

    // The store sets lastChecked to new Date() after a successful fetch,
    // so "last checked:" text should appear (e.g., "last checked: just now")
    await expect(page.getByText(/last checked:/i)).toBeVisible();
  });

  test("shows refresh button", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main"],
    });

    const refreshButton = page.getByRole("button", {
      name: /Refresh git status/i,
    });
    await expect(refreshButton).toBeVisible();
  });

  test("refresh button triggers fetch", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: (args: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__gitStatusCallCount = (w.__gitStatusCallCount ?? 0) + 1;
        void args;
        return {
          branchName: "main",
          dirtyCount: 0,
          ahead: 0,
          behind: 0,
        };
      },
      list_local_branches: () => ["main"],
    });

    // Wait for the branch chip to appear (initial fetch happened)
    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();

    // Record the call count after the initial fetch(es)
    const countBefore = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__gitStatusCallCount ?? 0;
    });

    // Click the refresh button
    const refreshButton = page.getByRole("button", {
      name: /Refresh git status/i,
    });
    await refreshButton.click();

    // Wait for the call count to increase
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (window as any).__gitStatusCallCount ?? 0;
        });
      })
      .toBeGreaterThan(countBefore);
  });

  test("shows error warning icon when git status fails", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, {
      get_repo_git_status: () => {
        throw new Error("failed to read git status");
      },
      list_local_branches: () => ["main"],
    });

    // When get_repo_git_status throws, the store sets error and status remains null.
    // The UI should show a warning indicator (⚠).
    await expect(page.getByText("\u26A0")).toBeVisible();
  });
});
