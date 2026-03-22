import { test, expect } from "./fixtures";

test.describe("Version and update UI", () => {
  test("shows current app version in the toolbar header", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      invokeHandlers: {
        "plugin:app|version": "0.1.0",
      },
    });
    await page.goto("/");

    const toolbarHeader = page.locator(".toolbar-header");
    await expect(toolbarHeader).toBeVisible();
    await expect(toolbarHeader.getByText("v0.1.0")).toBeVisible();
  });

  test("shows update button when an update is available", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      invokeHandlers: {
        "plugin:app|version": "0.1.0",
        "plugin:updater|check": {
          rid: 1,
          available: true,
          version: "0.2.0",
          date: "2026-03-22",
          body: "Bug fixes and improvements",
        },
        "plugin:updater|download_and_install": undefined,
        "plugin:resource|close": undefined,
      },
    });
    await page.goto("/");

    // The update button should show the new version
    const updateButton = page.getByRole("button", { name: /0\.2\.0/ });
    await expect(updateButton).toBeVisible();
  });

  test("update button triggers install flow on click", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      invokeHandlers: {
        "plugin:app|version": "0.1.0",
        "plugin:updater|check": {
          rid: 1,
          available: true,
          version: "0.2.0",
          date: "2026-03-22",
          body: "Bug fixes and improvements",
        },
        "plugin:updater|download_and_install": undefined,
        "plugin:resource|close": undefined,
        // dialog|ask returns true by default in fixtures, so the user confirms
      },
    });
    await page.goto("/");

    // Wait for the update button to appear
    const updateButton = page.getByRole("button", { name: /0\.2\.0/ });
    await expect(updateButton).toBeVisible();

    // Click the update button — this should call installUpdate() which shows
    // a confirmation dialog (mocked to return true) and then starts downloading
    await updateButton.click();

    // After confirming, the UI should transition to downloading state
    await expect(page.getByText("Downloading...")).toBeVisible();
  });

  test("shows downloading state with spinner", async ({ page, mockTauri }) => {
    // Use a handler that never resolves to keep the downloading state visible
    await mockTauri({
      invokeHandlers: {
        "plugin:app|version": "0.1.0",
        "plugin:updater|check": {
          rid: 1,
          available: true,
          version: "0.2.0",
          date: "2026-03-22",
          body: "Bug fixes",
        },
        "plugin:updater|download_and_install": () =>
          new Promise(() => {
            /* never resolves — simulates ongoing download */
          }),
        "plugin:resource|close": undefined,
      },
    });
    await page.goto("/");

    // Wait for update button and click it
    const updateButton = page.getByRole("button", { name: /0\.2\.0/ });
    await expect(updateButton).toBeVisible();
    await updateButton.click();

    // Should show downloading text
    await expect(page.getByText("Downloading...")).toBeVisible();

    // The update button with the version number should no longer be visible
    await expect(updateButton).not.toBeVisible();
  });
});
