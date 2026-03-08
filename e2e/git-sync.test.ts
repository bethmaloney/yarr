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

const localRepoWithGitSync = {
  ...localRepo,
  gitSync: {
    enabled: true,
    maxPushRetries: 3,
  },
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

test.describe("Git Sync settings section", () => {
  test("renders with 'disabled' label when gitSync is not configured", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri);

    const gitSyncSection = page.locator("details.git-sync");
    await expect(gitSyncSection).toBeVisible();

    const summary = gitSyncSection.locator("summary");
    await expect(summary).toContainText("Git Sync");
    await expect(summary).toContainText("disabled");
  });

  test("shows 'enabled' in summary when repo has gitSync enabled", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepoWithGitSync);

    const gitSyncSection = page.locator("details.git-sync");
    await expect(gitSyncSection).toBeVisible();

    const summary = gitSyncSection.locator("summary");
    await expect(summary).toContainText("Git Sync");
    await expect(summary).toContainText("enabled");
  });

  test("expanding section shows all fields", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri);

    // Expand the git-sync details section
    await page.locator("details.git-sync summary").click();

    // Enable checkbox
    const enableCheckbox = page.locator("details.git-sync").getByRole("checkbox");
    await expect(enableCheckbox).toBeVisible();

    // Model text input with placeholder "sonnet"
    const modelInput = page.locator("details.git-sync").getByPlaceholder("sonnet");
    await expect(modelInput).toBeVisible();

    // Max push retries number input (default value 3)
    const retriesInput = page
      .locator("details.git-sync")
      .getByRole("spinbutton");
    await expect(retriesInput).toBeVisible();
    await expect(retriesInput).toHaveValue("3");

    // Conflict resolution prompt textarea
    const textarea = page.locator("details.git-sync").getByRole("textbox", { name: /prompt|conflict/i });
    await expect(textarea).toBeVisible();
  });

  test("enable toggle updates summary text from disabled to enabled", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri);

    const gitSyncSection = page.locator("details.git-sync");
    const summary = gitSyncSection.locator("summary");

    // Initially disabled
    await expect(summary).toContainText("disabled");

    // Expand and click the enable checkbox
    await summary.click();
    const enableCheckbox = gitSyncSection.getByRole("checkbox");
    await enableCheckbox.check();

    // Summary should now say enabled
    await expect(summary).toContainText("enabled");
  });

  test("fields are dimmed when toggle is off", async ({ page, mockTauri }) => {
    await navigateToRepo(page, mockTauri);

    // Expand the git-sync section
    await page.locator("details.git-sync summary").click();

    const gitSyncSection = page.locator("details.git-sync");

    // Checkbox should be unchecked (git sync disabled by default)
    const enableCheckbox = gitSyncSection.getByRole("checkbox");
    await expect(enableCheckbox).not.toBeChecked();

    // Model input, retries input, and textarea should have reduced opacity
    const modelInput = gitSyncSection.getByPlaceholder("sonnet");
    const retriesInput = gitSyncSection.getByRole("spinbutton");
    const textarea = gitSyncSection.getByRole("textbox", { name: /prompt|conflict/i });

    // Check that the fields or their containers have reduced opacity when disabled
    for (const field of [modelInput, retriesInput, textarea]) {
      const opacity = await field.evaluate((el) => {
        // Walk up to find an element with reduced opacity
        let node: Element | null = el;
        while (node) {
          const style = window.getComputedStyle(node);
          const op = parseFloat(style.opacity);
          if (op < 1) return op;
          node = node.parentElement;
        }
        return 1;
      });
      expect(opacity).toBeLessThan(1);
    }
  });

  test("all fields disabled during running session", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Expand the git-sync section
    await page.locator("details.git-sync summary").click();

    const gitSyncSection = page.locator("details.git-sync");

    // All inputs should be disabled
    const enableCheckbox = gitSyncSection.getByRole("checkbox");
    await expect(enableCheckbox).toBeDisabled();

    const modelInput = gitSyncSection.getByPlaceholder("sonnet");
    await expect(modelInput).toBeDisabled();

    const retriesInput = gitSyncSection.getByRole("spinbutton");
    await expect(retriesInput).toBeDisabled();

    const textarea = gitSyncSection.getByRole("textbox", { name: /prompt|conflict/i });
    await expect(textarea).toBeDisabled();
  });

  test("gitSync config is included in run_session invoke parameters", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [localRepoWithGitSync] },
      invokeHandlers: {
        run_session: (args: Record<string, unknown>) => {
          // Store the args on the window so we can read them from the test
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__capturedRunSessionArgs = args;
          return new Promise(() => {}); // Never resolves — keeps session "running"
        },
      },
    });
    await page.goto("/");

    // Navigate to the repo
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Fill in plan file and click Run
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("/tmp/plan.md");
    await page.getByRole("button", { name: "Run", exact: true }).click();

    // Wait for the session to show as running
    await expect(page.getByText("Running...")).toBeVisible();

    // Read the captured args from the browser context
    const capturedArgs = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__capturedRunSessionArgs;
    });

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs.gitSync).toBeDefined();
    expect(capturedArgs.gitSync).toEqual({
      enabled: true,
      maxPushRetries: 3,
    });
  });

  test("gitSync is not included in run_session invoke when not configured", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [localRepo] },
      invokeHandlers: {
        run_session: (args: Record<string, unknown>) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).__capturedRunSessionArgs = args;
          return new Promise(() => {});
        },
      },
    });
    await page.goto("/");

    // Navigate to the repo
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Fill in plan file and click Run
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("/tmp/plan.md");
    await page.getByRole("button", { name: "Run", exact: true }).click();

    // Wait for the session to show as running
    await expect(page.getByText("Running...")).toBeVisible();

    // Read the captured args from the browser context
    const capturedArgs = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__capturedRunSessionArgs;
    });

    expect(capturedArgs).not.toBeNull();
    // gitSync should be undefined since the repo doesn't have it configured
    expect(capturedArgs.gitSync).toBeUndefined();
  });

  test("saving settings persists gitSync config", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri);

    // Expand the git-sync section and fill in the fields
    const gitSyncSection = page.locator("details.git-sync");
    await gitSyncSection.locator("summary").click();

    // Check the enable checkbox
    const enableCheckbox = gitSyncSection.getByRole("checkbox");
    await enableCheckbox.check();

    // Fill in model
    const modelInput = gitSyncSection.getByPlaceholder("sonnet");
    await modelInput.fill("sonnet");

    // Set max push retries to 5
    const retriesInput = gitSyncSection.getByRole("spinbutton");
    await retriesInput.fill("5");

    // Fill in conflict prompt
    const textarea = gitSyncSection.getByRole("textbox", { name: /prompt|conflict/i });
    await textarea.fill("Custom prompt");

    // Expand the settings section and click Save
    await page.locator("details.settings summary").click();
    await page
      .locator("details.settings")
      .getByRole("button", { name: "Save" })
      .click();

    // Navigate away by clicking the "Home" breadcrumb
    await page.locator(".breadcrumbs").getByRole("button", { name: "Home" }).click();

    // Navigate back to the repo
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // Expand git-sync and verify persisted values
    const gitSyncAfter = page.locator("details.git-sync");
    await gitSyncAfter.locator("summary").click();

    // Summary should show enabled
    await expect(gitSyncAfter.locator("summary")).toContainText("enabled");

    // Checkbox should be checked
    await expect(gitSyncAfter.getByRole("checkbox")).toBeChecked();

    // Model should be "sonnet"
    await expect(gitSyncAfter.getByPlaceholder("sonnet")).toHaveValue("sonnet");

    // Max push retries should be 5
    await expect(gitSyncAfter.getByRole("spinbutton")).toHaveValue("5");

    // Conflict prompt should be "Custom prompt"
    await expect(
      gitSyncAfter.getByRole("textbox", { name: /prompt|conflict/i }),
    ).toHaveValue("Custom prompt");
  });
});
