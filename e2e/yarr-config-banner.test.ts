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
  await mockTauri({ storeData: { repos: [repo] }, invokeHandlers });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

async function openConfigSheet(page: import("@playwright/test").Page) {
  await page.locator(".settings").click();
}

test.describe("Yarr config status banner", () => {
  test("shows loaded banner with field count when config has fields", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: {
        config: {
          model: "sonnet",
          maxIterations: 20,
          completionSignal: "DONE",
        },
        error: null,
      },
    });
    await openConfigSheet(page);

    const banner = page.getByTestId("yarr-config-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("yarr.yml");
    await expect(banner).toContainText("loaded");
    await expect(banner).toContainText("3");
    await expect(banner).toHaveClass(/text-info/);
  });

  test("shows not found banner when config is null with no error", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: null },
    });
    await openConfigSheet(page);

    const banner = page.getByTestId("yarr-config-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("yarr.yml");
    await expect(banner).toContainText(/not found/i);
    await expect(banner).toHaveClass(/text-muted-foreground/);
  });

  test("shows warning banner when config has parse error", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepo(page, mockTauri, localRepo, {
      read_yarr_config: { config: null, error: "invalid YAML at line 5" },
    });
    await openConfigSheet(page);

    const banner = page.getByTestId("yarr-config-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("invalid YAML at line 5");
    await expect(banner).toHaveClass(/text-warning/);
  });
});
