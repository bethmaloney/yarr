import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

// Sparse repo — no overrides set, so all fields use defaults
const localRepo = {
  type: "local" as const,
  id: "local-repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
};

async function navigateToRepo(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  repo: Record<string, unknown> = localRepo,
  invokeHandlers: Record<string, unknown> = {},
) {
  await mockTauri({ storeData: { repos: [repo] }, invokeHandlers });
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

// ---------------------------------------------------------------------------
// 1. Default source — no badges
// ---------------------------------------------------------------------------
test.describe("Config source badges — default source", () => {
  test("no badges shown when all fields use defaults (no overrides, no yarr.yml)", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // No "repo config" badges should be visible
    await expect(
      sheet.locator("span.text-xs.font-mono.text-info", {
        hasText: "repo config",
      }),
    ).toHaveCount(0);

    // No "custom" badges should be visible
    await expect(
      sheet.locator("span.text-xs.font-mono.text-primary", {
        hasText: "custom",
      }),
    ).toHaveCount(0);

    // No reset buttons should be visible
    await expect(
      sheet.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 2. yarr-yml source — "repo config" badges
// ---------------------------------------------------------------------------
test.describe("Config source badges — yarr-yml source", () => {
  test("fields from .yarr.yml show 'repo config' badge with text-info class", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: {
        config: {
          model: "sonnet",
          maxIterations: 20,
        },
        error: null,
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // Model field should have "repo config" badge
    const modelLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Model",
    });
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-info", {
        hasText: "repo config",
      }),
    ).toBeVisible();

    // Max Iterations field should have "repo config" badge
    const maxIterLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Max Iterations",
    });
    await expect(
      maxIterLabel.locator("span.text-xs.font-mono.text-info", {
        hasText: "repo config",
      }),
    ).toBeVisible();

    // Fields NOT in .yarr.yml should not have any badge
    const effortLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Effort Level",
    });
    await expect(effortLabel.locator("span.text-xs.font-mono")).toHaveCount(0);
  });

  test("yarr-yml fields do not show reset button", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: {
        config: { model: "sonnet" },
        error: null,
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // The "repo config" badge should be visible but no reset button
    const modelLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Model",
    });
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-info"),
    ).toBeVisible();
    await expect(
      modelLabel.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Override source — "custom" badges with reset button
// ---------------------------------------------------------------------------
test.describe("Config source badges — override source", () => {
  test("fields with repo overrides show 'custom' badge with text-primary class and reset button", async ({
    page,
    mockTauri,
  }) => {
    const repoWithOverrides = {
      ...localRepo,
      model: "sonnet",
      maxIterations: 10,
    };

    await navigateToRepo(page, mockTauri, repoWithOverrides, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // Model field should have "custom" badge
    const modelLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Model",
    });
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-primary", {
        hasText: "custom",
      }),
    ).toBeVisible();

    // Model field should have a reset button
    await expect(
      modelLabel.getByRole("button", { name: "Reset to default" }),
    ).toBeVisible();

    // Max Iterations field should have "custom" badge
    const maxIterLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Max Iterations",
    });
    await expect(
      maxIterLabel.locator("span.text-xs.font-mono.text-primary", {
        hasText: "custom",
      }),
    ).toBeVisible();

    // Max Iterations field should have a reset button
    await expect(
      maxIterLabel.getByRole("button", { name: "Reset to default" }),
    ).toBeVisible();
  });

  test("fields without overrides show no badge when no yarr.yml", async ({
    page,
    mockTauri,
  }) => {
    const repoWithOverrides = {
      ...localRepo,
      model: "sonnet",
    };

    await navigateToRepo(page, mockTauri, repoWithOverrides, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // Effort Level should have no badge (still default)
    const effortLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Effort Level",
    });
    await expect(effortLabel.locator("span.text-xs.font-mono")).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Mixed sources — override + yarr-yml + default on different fields
// ---------------------------------------------------------------------------
test.describe("Config source badges — mixed sources", () => {
  test("correct badges for each source tier: override, yarr-yml, and default", async ({
    page,
    mockTauri,
  }) => {
    // Repo overrides model
    const repoWithModelOverride = {
      ...localRepo,
      model: "sonnet",
    };

    await navigateToRepo(page, mockTauri, repoWithModelOverride, {
      read_yarr_config: {
        config: {
          // yarr.yml provides maxIterations and createBranch
          maxIterations: 20,
          createBranch: false,
        },
        error: null,
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // Model — overridden by repo: "custom" badge + reset button
    const modelLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Model",
    });
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-primary", {
        hasText: "custom",
      }),
    ).toBeVisible();
    await expect(
      modelLabel.getByRole("button", { name: "Reset to default" }),
    ).toBeVisible();

    // Max Iterations — from yarr.yml: "repo config" badge, no reset button
    const maxIterLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Max Iterations",
    });
    await expect(
      maxIterLabel.locator("span.text-xs.font-mono.text-info", {
        hasText: "repo config",
      }),
    ).toBeVisible();
    await expect(
      maxIterLabel.getByRole("button", { name: "Reset to default" }),
    ).toHaveCount(0);

    // Create Branch — from yarr.yml: "repo config" badge
    const createBranchLabel = sheet.locator(
      "span.text-sm.text-muted-foreground",
      { hasText: "Create Branch" },
    );
    await expect(
      createBranchLabel.locator("span.text-xs.font-mono.text-info", {
        hasText: "repo config",
      }),
    ).toBeVisible();

    // Effort Level — default: no badge at all
    const effortLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Effort Level",
    });
    await expect(effortLabel.locator("span.text-xs.font-mono")).toHaveCount(0);

    // Completion Signal — default: no badge
    const completionLabel = sheet.locator(
      "span.text-sm.text-muted-foreground",
      { hasText: "Completion Signal" },
    );
    await expect(completionLabel.locator("span.text-xs.font-mono")).toHaveCount(
      0,
    );
  });

  test("override takes precedence over yarr-yml for the same field", async ({
    page,
    mockTauri,
  }) => {
    // Both repo and yarr.yml set model — repo override wins
    const repoWithModelOverride = {
      ...localRepo,
      model: "haiku",
    };

    await navigateToRepo(page, mockTauri, repoWithModelOverride, {
      read_yarr_config: {
        config: {
          model: "sonnet",
        },
        error: null,
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    // Model should show "custom" badge (override wins over yarr-yml)
    const modelLabel = sheet.locator("span.text-sm.text-muted-foreground", {
      hasText: "Model",
    });
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-primary", {
        hasText: "custom",
      }),
    ).toBeVisible();

    // Should NOT show "repo config" badge
    await expect(
      modelLabel.locator("span.text-xs.font-mono.text-info"),
    ).toHaveCount(0);
  });

  test("all behavior and plans fields show correct badges from yarr-yml", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: {
        config: {
          autoFetch: true,
          plansDir: "plans/",
          movePlansToCompleted: false,
          designPromptFile: "prompts/design.md",
          implementationPromptFile: "prompts/impl.md",
        },
        error: null,
      },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    const fieldsWithYamlBadge = [
      "Auto Fetch",
      "Plans Dir",
      "Move Plans to Completed",
      "Design Prompt File",
      "Implementation Prompt File",
    ];

    for (const fieldName of fieldsWithYamlBadge) {
      const label = sheet.locator("span.text-sm.text-muted-foreground", {
        hasText: fieldName,
      });
      await expect(
        label.locator("span.text-xs.font-mono.text-info", {
          hasText: "repo config",
        }),
      ).toBeVisible();
    }
  });

  test("all model/execution fields show correct badges from overrides", async ({
    page,
    mockTauri,
  }) => {
    const repoWithAllOverrides = {
      ...localRepo,
      model: "sonnet",
      effortLevel: "high",
      maxIterations: 5,
      completionSignal: "DONE",
    };

    await navigateToRepo(page, mockTauri, repoWithAllOverrides, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const sheet = sheetContent(page);

    const fieldsWithCustomBadge = [
      "Model",
      "Effort Level",
      "Max Iterations",
      "Completion Signal",
    ];

    for (const fieldName of fieldsWithCustomBadge) {
      const label = sheet.locator("span.text-sm.text-muted-foreground", {
        hasText: fieldName,
      });
      await expect(
        label.locator("span.text-xs.font-mono.text-primary", {
          hasText: "custom",
        }),
      ).toBeVisible();
      await expect(
        label.getByRole("button", { name: "Reset to default" }),
      ).toBeVisible();
    }
  });
});
