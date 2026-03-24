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

const sshRepo = {
  type: "ssh" as const,
  id: "ssh-repo-1",
  sshHost: "dev-server",
  remotePath: "/home/user/projects/my-app",
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
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
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
  test("shows branch name when get_repo_git_status succeeds", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
  });

  test("hides branch chip when get_repo_git_status fails", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => {
        throw new Error("not a git repo");
      },
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).not.toBeVisible();
  });

  test("shows ahead indicator", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "feature/foo",
        dirtyCount: 0,
        ahead: 3,
        behind: 0,
      }),
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
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 5,
      }),
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
      get_repo_git_status: () => ({
        branchName: "develop",
        dirtyCount: 0,
        ahead: 2,
        behind: 3,
      }),
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
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();

    // Dropdown should not be visible initially
    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).not.toBeVisible();

    // Click the chip to open the dropdown
    await chip.click();
    await expect(dropdown).toBeVisible();

    // Verify all branch names appear in the dropdown
    const branchItems = dropdown.locator(".branch-item");
    await expect(branchItems).toHaveCount(3);
    await expect(branchItems.nth(0)).toContainText("main");
    await expect(branchItems.nth(1)).toContainText("feature/foo");
    await expect(branchItems.nth(2)).toContainText("develop");

    // Current branch should have the active class
    const activeItem = dropdown.locator(".branch-item.active");
    await expect(activeItem).toHaveCount(1);
    await expect(activeItem).toContainText("main");
  });

  test("shows fast-forward button when behind", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 2,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Fast-forward button should be present when behind > 0
    await expect(
      dropdown.getByRole("button", { name: /fast-forward/i }),
    ).toBeVisible();
  });

  test("fast-forward button shows loading state and disables during operation", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__ffGitStatusCount = (w.__ffGitStatusCount ?? 0) + 1;
        if (w.__ffGitStatusCount <= 2) {
          return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 2 };
        }
        return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 0 };
      },
      list_local_branches: () => ["main", "feature/foo", "develop"],
      fast_forward_branch: () =>
        new Promise((resolve) => setTimeout(resolve, 500)),
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const ffButton = dropdown.getByRole("button", { name: /fast-forward/i });
    await expect(ffButton).toBeVisible();

    // Click the fast-forward button
    await ffButton.click();

    // Button should be disabled and show loading text during the operation
    await expect(ffButton).toBeDisabled();
    await expect(ffButton).toContainText("Fast-forwarding\u2026");

    // After the promise resolves, the dropdown should close
    await expect(dropdown).not.toBeVisible({ timeout: 5000 });
  });

  test("fast-forward updates git status before closing dropdown", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__ffRefreshCount = (w.__ffRefreshCount ?? 0) + 1;
        if (w.__ffRefreshCount <= 2) {
          return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 2 };
        }
        return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 0 };
      },
      list_local_branches: () => ["main", "feature/foo", "develop"],
      fast_forward_branch: () => Promise.resolve(),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toContainText("\u21932");

    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const ffButton = dropdown.getByRole("button", { name: /fast-forward/i });
    await ffButton.click();

    // After fast-forward completes, dropdown should close
    await expect(dropdown).not.toBeVisible({ timeout: 5000 });

    // The behind indicator should be gone — git status was refreshed before closing
    await expect(chip).not.toContainText("\u21932");
  });

  test("does not show fast-forward button when not behind", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
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
      get_repo_git_status: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__gitStatusCallCount = (w.__gitStatusCallCount ?? 0) + 1;
        if (w.__gitStatusCallCount <= 2) {
          return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 0 };
        }
        return {
          branchName: "feature/foo",
          dirtyCount: 0,
          ahead: 1,
          behind: 0,
        };
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
    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    // Click "feature/foo" branch
    await dropdown.locator(".branch-item", { hasText: "feature/foo" }).click();

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

    // The chip should be disabled while running
    await expect(chip).toBeDisabled();

    // Click the chip — dropdown should NOT open while session is running
    await chip.click({ force: true });

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).not.toBeVisible();
  });

  test("click outside closes dropdown", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
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
        get_repo_git_status: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = window as any;
          w.__gitStatusCallCount = (w.__gitStatusCallCount ?? 0) + 1;
          if (w.__gitStatusCallCount <= 1) {
            return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 0 };
          }
          // After session completes, simulate that we are now ahead by 3
          return { branchName: "main", dirtyCount: 0, ahead: 3, behind: 0 };
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

  test("search input appears and auto-focuses when dropdown opens", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused();
  });

  test("search filters branches by substring", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => [
        "main",
        "feature/login",
        "feature/signup",
        "develop",
        "fix/bug-123",
      ],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    const branchItems = dropdown.locator(".branch-item");

    // Type "feature" to filter
    await searchInput.fill("feature");
    await expect(branchItems).toHaveCount(2);
    await expect(branchItems.nth(0)).toContainText("feature/login");
    await expect(branchItems.nth(1)).toContainText("feature/signup");

    // Clear and type "main"
    await searchInput.fill("main");
    await expect(branchItems).toHaveCount(1);
    await expect(branchItems.nth(0)).toContainText("main");
  });

  test("search is case-insensitive", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "Feature/Login"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await searchInput.fill("feature");

    const branchItems = dropdown.locator(".branch-item");
    await expect(branchItems).toHaveCount(1);
    await expect(branchItems.nth(0)).toContainText("Feature/Login");
  });

  test("shows empty state when no branches match", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await searchInput.fill("nonexistent");

    const branchItems = dropdown.locator(".branch-item");
    await expect(branchItems).toHaveCount(0);

    const emptyState = page.locator(".branch-empty");
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText("No matching branches");
  });

  test("Enter selects first matching branch", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        w.__gitStatusCallCount = (w.__gitStatusCallCount ?? 0) + 1;
        if (w.__gitStatusCallCount <= 1) {
          return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 0 };
        }
        return {
          branchName: "feature/login",
          dirtyCount: 0,
          ahead: 0,
          behind: 0,
        };
      },
      list_local_branches: () => [
        "main",
        "feature/login",
        "feature/signup",
        "develop",
      ],
      switch_branch: (args: Record<string, unknown>) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__switchBranchArgs = args;
        return null;
      },
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await searchInput.fill("feat");
    await searchInput.press("Enter");

    // Verify switch_branch was called with the first matching branch
    const capturedArgs = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__switchBranchArgs;
    });
    expect(capturedArgs).toBeTruthy();
    expect(capturedArgs.branch).toBe("feature/login");

    // Dropdown should close after selection
    await expect(dropdown).not.toBeVisible();
  });

  test("Escape closes dropdown and clears search", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await searchInput.fill("feat");

    // Press Escape to close dropdown
    await searchInput.press("Escape");
    await expect(dropdown).not.toBeVisible();

    // Re-open dropdown
    await chip.click();
    await expect(dropdown).toBeVisible();

    // Search input should be empty after re-opening
    await expect(page.locator("input.branch-search")).toHaveValue("");
  });

  test("search resets when branch is selected by click", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 0,
        ahead: 0,
        behind: 0,
      }),
      list_local_branches: () => ["main", "feature/foo", "develop"],
      switch_branch: () => null,
    });

    const chip = page.locator("button.branch-chip");
    await chip.click();

    const dropdown = page.locator(".branch-dropdown");
    await expect(dropdown).toBeVisible();

    const searchInput = page.locator("input.branch-search");
    await searchInput.fill("dev");

    // Click the matching branch item
    await dropdown.locator(".branch-item", { hasText: "develop" }).click();

    // Dropdown should close
    await expect(dropdown).not.toBeVisible();

    // Re-open dropdown
    await chip.click();
    await expect(dropdown).toBeVisible();

    // Search input should be empty
    await expect(page.locator("input.branch-search")).toHaveValue("");
  });

  // --- Home page repo card tests ---

  test("Home page repo card shows dirty count", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: { repos: [localRepo] },
      invokeHandlers: {
        get_repo_git_status: () => ({
          branchName: "main",
          dirtyCount: 5,
          ahead: 0,
          behind: 0,
        }),
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("5 dirty");
  });

  test("Home page repo card shows behind indicator", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [localRepo] },
      invokeHandlers: {
        get_repo_git_status: () => ({
          branchName: "main",
          dirtyCount: 0,
          ahead: 0,
          behind: 3,
        }),
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("3\u2193");
  });

  test("Home page repo card shows last checked for SSH repo", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [sshRepo] },
      invokeHandlers: {
        get_repo_git_status: () => ({
          branchName: "main",
          dirtyCount: 0,
          ahead: 0,
          behind: 0,
        }),
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", { name: /my-app/ });
    await expect(card).toBeVisible();
    await expect(card).toContainText("last checked");
  });

  test("branch chip renders correctly when ahead/behind are null", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      get_repo_git_status: () => ({
        branchName: "main",
        dirtyCount: 2,
        ahead: null,
        behind: null,
      }),
    });

    const chip = page.locator("button.branch-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("main");
    await expect(chip).toContainText("2 dirty");
    // Should NOT show any ahead/behind indicators
    await expect(chip).not.toContainText("\u2191");
    await expect(chip).not.toContainText("\u2193");
  });
});
