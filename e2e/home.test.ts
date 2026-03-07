import { test, expect } from "./fixtures";

test.describe("Home view", () => {
  test("shows empty state when no repos configured", async ({ tauriPage: page }) => {
    await expect(page.getByText("No repos configured yet.")).toBeVisible();
    await expect(page.getByRole("button", { name: "+ Add repo" })).toBeVisible();
  });

  test("shows repo cards when repos exist", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: {
        repos: [
          {
            id: "repo-1",
            path: "/home/user/projects/my-app",
            name: "my-app",
            model: "opus",
            maxIterations: 40,
            completionSignal: "ALL TODO ITEMS COMPLETE",
          },
          {
            id: "repo-2",
            path: "/home/user/projects/api-server",
            name: "api-server",
            model: "sonnet",
            maxIterations: 20,
            completionSignal: "DONE",
          },
        ],
      },
    });
    await page.goto("/");

    await expect(page.getByRole("button", { name: /my-app/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /api-server/ })).toBeVisible();
    await expect(page.getByText("No repos configured yet.")).not.toBeVisible();
  });

  test("navigates to repo detail on card click", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: {
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
      },
    });
    await page.goto("/");

    await page.getByRole("button", { name: /my-app/ }).click();
    // RepoDetail shows the repo name as h1 and the path
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await expect(page.getByText("/home/user/projects/my-app")).toBeVisible();
  });
});
