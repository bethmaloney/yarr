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

async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  repo: Record<string, unknown> = localRepo,
  invokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({
    storeData: { repos: [repo] },
    invokeHandlers,
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

async function startRunningSession(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  extraInvokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({
    storeData: { repos: [localRepo] },
    invokeHandlers: {
      run_session: () => new Promise(() => {}),
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 0 }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
      ...extraInvokeHandlers,
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

test.describe("Branch display chip", () => {
  test("shows branch name when get_branch_info succeeds", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 0 }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
  });

  test("hides branch chip when get_branch_info fails", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => {
        throw new Error("not a git repo");
      },
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).not.toBeVisible();
  });

  test("shows ahead indicator", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "feature/foo", ahead: 3, behind: 0 }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("feature/foo");
    await expect(chip).toContainText("\u21913");
  });

  test("shows behind indicator with warning style", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 5 }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("\u21935");
    await expect(chip).toHaveClass(/warning/);
  });

  test("shows both ahead and behind indicators", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "develop", ahead: 2, behind: 3 }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("\u21912");
    await expect(chip).toContainText("\u21933");
    await expect(chip).toHaveClass(/warning/);
  });

  test("opens dropdown with branch list on click", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 0 }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();

    // Dropdown should not be visible initially
    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).not.toBeVisible();

    // Click the chip to open the dropdown
    await chip.click();
    await expect(dropdown).toBeVisible();

    // Verify all branch names appear in the dropdown
    const branchItems = dropdown.locator("button.branch-item");
    await expect(branchItems).toHaveCount(3);
    await expect(branchItems.nth(0)).toContainText("main");
    await expect(branchItems.nth(1)).toContainText("feature/foo");
    await expect(branchItems.nth(2)).toContainText("develop");

    // Current branch should have the active class
    const activeItem = dropdown.locator("button.branch-item.active");
    await expect(activeItem).toHaveCount(1);
    await expect(activeItem).toContainText("main");
  });

  test("shows fast-forward button when behind", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 2 }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Fast-forward button should be present when behind > 0
    await expect(
      dropdown.getByRole("button", { name: /fast-forward/i }),
    ).toBeVisible();
  });

  test("does not show fast-forward button when not behind", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 0 }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Fast-forward button should NOT be present when behind === 0
    await expect(
      dropdown.getByRole("button", { name: /fast-forward/i }),
    ).not.toBeVisible();
  });

  test("switching branch calls switch_branch and refreshes", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__branchInfoCallCount = (w.__branchInfoCallCount ?? 0) + 1;
        if (w.__branchInfoCallCount <= 1) {
          return { name: "main", ahead: 0, behind: 0 };
        }
        return { name: "feature/foo", ahead: 1, behind: 0 };
      },
      list_local_branches: () => ["main", "feature/foo", "develop"],
      switch_branch: (args: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__switchBranchArgs = args;
        return null;
      },
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toContainText("main");

    // Open the dropdown
    await chip.click();
    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Click "feature/foo" branch
    await dropdown
      .locator("button.branch-item", { hasText: "feature/foo" })
      .click();

    // Verify switch_branch was called with correct args
    const capturedArgs = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__switchBranchArgs;
    });
    expect(capturedArgs).toBeTruthy();
    expect(capturedArgs.branch).toBe("feature/foo");

    // Chip should update to show the new branch name
    await expect(chip).toContainText("feature/foo");

    // Dropdown should close after switching
    await expect(dropdown).not.toBeVisible();
  });

  test("dropdown is disabled during running session", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();

    // Click the chip — dropdown should NOT open while session is running
    await chip.click();

    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).not.toBeVisible();
  });

  test("click outside closes dropdown", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_branch_info: () => ({ name: "main", ahead: 0, behind: 0 }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator("div.branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Click outside the dropdown (on the page heading)
    await page.locator("h1").click();

    await expect(dropdown).not.toBeVisible();
  });

  test("branch info refreshes after session completes", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [localRepo] },
      invokeHandlers: {
        get_branch_info: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          w.__branchInfoCallCount = (w.__branchInfoCallCount ?? 0) + 1;
          if (w.__branchInfoCallCount <= 1) {
            return { name: "main", ahead: 0, behind: 0 };
          }
          // After session completes, simulate that we are now ahead by 3
          return { name: "main", ahead: 3, behind: 0 };
        },
        list_local_branches: () => ["main", "feature/foo", "develop"],
        run_session: () =>
          new Promise<void>((resolve) => {
            // Store resolve on window so we can call it from page.evaluate
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).__resolveSession = resolve;
          }),
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");

    // Start a session
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("/tmp/plan.md");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Running...")).toBeVisible();

    // Resolve the session to simulate completion
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolve = (window as any).__resolveSession;
      if (resolve) resolve();
    });

    // After session completes, the chip should refresh and show the ahead indicator
    await expect(chip).toContainText("\u21913");
  });
});
