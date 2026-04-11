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
test.describe("Export .yarr.yml button", () => {
  // -------------------------------------------------------------------------
  // 1. Export button is visible in settings sheet footer
  // -------------------------------------------------------------------------
  test("export button is visible in settings sheet footer with Download icon", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toContainText("Export .yarr.yml");

    // Verify the Download icon is present (Lucide renders an SVG)
    await expect(exportBtn.locator("svg")).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 2. Export button is disabled when session is running
  // -------------------------------------------------------------------------
  test("export button is disabled when session is running", async ({
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

    // Now open config sheet and check export button is disabled
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await expect(exportBtn).toBeVisible();
    await expect(exportBtn).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // 3. Export button calls IPC with effective config
  // -------------------------------------------------------------------------
  test("export button calls export_yarr_config IPC with repo and config", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
      export_yarr_config: (args: Record<string, unknown>) => {
        (window as unknown as Record<string, unknown>).__capturedExportArgs =
          args;
        return null;
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    // Verify the IPC was called with expected arguments
    const capturedArgs = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__capturedExportArgs as
          | Record<string, unknown>
          | undefined,
    );

    expect(capturedArgs).toBeDefined();
    // repo payload should have local type and path
    const repo = capturedArgs!.repo as Record<string, unknown>;
    expect(repo).toMatchObject({
      type: "local",
      path: "/home/user/projects/my-app",
    });
    // config payload should be present
    expect(capturedArgs!.config).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 4. Export shows success toast on success
  // -------------------------------------------------------------------------
  test("export shows success toast on successful export", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
      export_yarr_config: () => null,
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    // Verify success toast appears (Sonner renders toasts in an <ol>)
    const toast = page.locator("[data-sonner-toast]", {
      hasText: ".yarr.yml written to repo root",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  // -------------------------------------------------------------------------
  // 5. Export shows error toast on failure
  // -------------------------------------------------------------------------
  test("export shows error toast when IPC fails", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
      export_yarr_config: () => {
        throw new Error("Permission denied: cannot write to repo");
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    // Verify error toast appears with the error message
    const toast = page.locator("[data-sonner-toast]", {
      hasText: "Permission denied: cannot write to repo",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  // -------------------------------------------------------------------------
  // 6. Export triggers yarrConfig refresh
  // -------------------------------------------------------------------------
  test("export triggers read_yarr_config refresh after success", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: () => {
        (window as unknown as Record<string, number>).__readYarrConfigCount =
          ((window as unknown as Record<string, number>)
            .__readYarrConfigCount || 0) + 1;
        return { config: null, error: null };
      },
      export_yarr_config: () => null,
    });

    // Record the call count before export
    const countBefore = await page.evaluate(
      () =>
        (window as unknown as Record<string, number>).__readYarrConfigCount ||
        0,
    );

    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    // Wait for the success toast first to ensure export completed
    const toast = page.locator("[data-sonner-toast]", {
      hasText: ".yarr.yml written to repo root",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });

    // Verify read_yarr_config was called again after export
    const countAfter = await page.evaluate(
      () =>
        (window as unknown as Record<string, number>).__readYarrConfigCount ||
        0,
    );

    expect(countAfter).toBeGreaterThan(countBefore);
  });

  // -------------------------------------------------------------------------
  // 7. Export preserves existing yaml fields and merges overrides
  // -------------------------------------------------------------------------
  test("export merges existing yaml values with overrides instead of rebuilding from scratch", async ({
    page,
    mockTauri,
  }) => {
    const existingYaml = {
      model: "sonnet",
      effortLevel: "low",
      maxIterations: 20,
      checks: [{ name: "lint", command: "npm run lint" }],
    };

    await navigateToRepo(
      page,
      mockTauri,
      // repo has effortLevel override
      { ...localRepo, effortLevel: "high" },
      {
        read_yarr_config: { config: existingYaml, error: null },
        export_yarr_config: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedExportArgs =
            args;
          return null;
        },
      },
    );
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    const capturedArgs = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__capturedExportArgs as
          | Record<string, unknown>
          | undefined,
    );

    expect(capturedArgs).toBeDefined();
    const config = capturedArgs!.config as Record<string, unknown>;

    // Override should be applied
    expect(config.effortLevel).toBe("high");

    // Existing yaml values should be preserved
    expect(config.model).toBe("sonnet");
    expect(config.maxIterations).toBe(20);
    expect(config.checks).toEqual([{ name: "lint", command: "npm run lint" }]);
  });

  // -------------------------------------------------------------------------
  // 8. Export without existing yaml still works (no confirmation dialog)
  // -------------------------------------------------------------------------
  test("export without existing yaml works without confirmation", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(
      page,
      mockTauri,
      { ...localRepo, effortLevel: "high" },
      {
        read_yarr_config: { config: null, error: null },
        export_yarr_config: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedExportArgs =
            args;
          return null;
        },
      },
    );
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    const exportBtn = sheet.getByTestId("export-yarr-config");

    await exportBtn.click();

    // Should succeed without dialog
    const toast = page.locator("[data-sonner-toast]", {
      hasText: ".yarr.yml written to repo root",
    });
    await expect(toast).toBeVisible({ timeout: 5000 });

    const capturedArgs = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__capturedExportArgs as
          | Record<string, unknown>
          | undefined,
    );
    expect(capturedArgs).toBeDefined();
    const config = capturedArgs!.config as Record<string, unknown>;

    // Override should be included
    expect(config.effortLevel).toBe("high");
  });

  // -------------------------------------------------------------------------
  // 9. Export preserves complex fields (envVars/checks/gitSync) saved as
  //    repo overrides — regression test for the case where the user clicks
  //    Save (storing values as overrides) and later clicks Export. Without
  //    this, the exported file silently dropped those values.
  // -------------------------------------------------------------------------
  test("export preserves envVars/checks/gitSync stored as repo overrides", async ({
    page,
    mockTauri,
  }) => {
    const repoWithOverrides = {
      ...localRepo,
      envVars: { OVERRIDE_KEY: "override_value" },
      checks: [
        {
          name: "test",
          command: "npm test",
          when: "each_iteration",
          timeoutSecs: 300,
          maxRetries: 2,
        },
      ],
      gitSync: {
        enabled: true,
        maxPushRetries: 5,
      },
    };

    await navigateToRepo(page, mockTauri, repoWithOverrides, {
      // No existing .yarr.yml
      read_yarr_config: { config: null, error: null },
      export_yarr_config: (args: Record<string, unknown>) => {
        (window as unknown as Record<string, unknown>).__capturedExportArgs =
          args;
        return null;
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);
    // Click Export without modifying anything — the form is auto-populated
    // from the override values.
    await sheet.getByTestId("export-yarr-config").click();

    const capturedArgs = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__capturedExportArgs as
          | Record<string, unknown>
          | undefined,
    );

    expect(capturedArgs).toBeDefined();
    const config = capturedArgs!.config as Record<string, unknown>;

    // All three complex fields stored as overrides should round-trip into
    // the exported config.
    expect(config.env).toEqual({ OVERRIDE_KEY: "override_value" });
    expect(config.checks).toBeDefined();
    expect((config.checks as unknown[]).length).toBe(1);
    expect(config.gitSync).toMatchObject({
      enabled: true,
      maxPushRetries: 5,
    });
  });
});
