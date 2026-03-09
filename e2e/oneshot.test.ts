import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const repoStoreData = {
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
};

async function navigateToRepoDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  invokeHandlers?: Record<string, unknown>,
) {
  await mockTauri({
    storeData: repoStoreData,
    invokeHandlers: {
      get_active_sessions: () => [],
      run_oneshot: () => null,
      ...invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

test.describe("1-Shot navigation", () => {
  test('"1-Shot" button is visible on repo detail page', async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    await expect(page.getByRole("button", { name: "1-Shot" })).toBeVisible();
  });

  test('clicking "1-Shot" navigates to the OneShotView', async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    await page.getByRole("button", { name: "1-Shot" }).click();

    // OneShotView should show the h1 with "1-Shot" text
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // The form should have Title and Prompt inputs
    await expect(page.getByText("Title")).toBeVisible();
    await expect(page.getByText("Prompt")).toBeVisible();

    // The "Run" button should be present
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible();
  });

  test("back navigation from OneShotView returns to home view", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);

    // Navigate to 1-Shot view
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Click the "Home" breadcrumb link to go back
    await page.getByRole("button", { name: "Home" }).click();

    // Should return to the home view
    await expect(page.locator("h1", { hasText: "Yarr" })).toBeVisible();
  });

  test("OneShotView shows correct repo name", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    await page.getByRole("button", { name: "1-Shot" }).click();

    // The h1 should contain the repo name
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

    // The full heading should be "{repo.name} — 1-Shot"
    await expect(page.locator("h1")).toContainText("my-app");
  });
});

// ---------------------------------------------------------------------------
// Helper: navigate to the 1-Shot view from repo detail
// ---------------------------------------------------------------------------
async function navigateToOneShotView(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  invokeHandlers?: Record<string, unknown>,
) {
  await navigateToRepoDetail(page, mockTauri, invokeHandlers);
  await page.getByRole("button", { name: "1-Shot" }).click();
  await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// 1-Shot form interaction
// ---------------------------------------------------------------------------
test.describe("1-Shot form interaction", () => {
  test("form shows Title, Prompt, Model, and Merge Strategy fields", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    await expect(page.getByText("Title")).toBeVisible();
    await expect(page.getByText("Prompt")).toBeVisible();
    await expect(page.getByText("Model")).toBeVisible();
    await expect(page.getByText("Merge Strategy")).toBeVisible();
  });

  test("Model field is pre-filled with repo default model", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    // The repo's model is "opus" — the Model input should have that value
    const modelInput = page.locator(
      '.form-section label:has-text("Model") input[type="text"]',
    );
    await expect(modelInput).toHaveValue("opus");
  });

  test("Run button is disabled when title is empty", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    // Leave title empty, fill prompt
    await page.locator(".form-section textarea").fill("Do something");

    const runButton = page.getByRole("button", { name: "Run" });
    await expect(runButton).toBeDisabled();
  });

  test("Run button is disabled when prompt is empty", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    // Fill title, leave prompt empty
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("My Task");

    const runButton = page.getByRole("button", { name: "Run" });
    await expect(runButton).toBeDisabled();
  });

  test("Run button is enabled when both title and prompt are filled", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("My Task");
    await page.locator(".form-section textarea").fill("Do something important");

    const runButton = page.getByRole("button", { name: "Run" });
    await expect(runButton).toBeEnabled();
  });

  test("Merge strategy defaults to Merge to main", async ({
    page,
    mockTauri,
  }) => {
    await navigateToOneShotView(page, mockTauri);

    // The "Merge to main" radio should be checked by default
    const mergeToMainRadio = page.locator(
      'input[type="radio"][value="merge_to_main"]',
    );
    await expect(mergeToMainRadio).toBeChecked();

    // The "Create branch" radio should not be checked
    const branchRadio = page.locator('input[type="radio"][value="branch"]');
    await expect(branchRadio).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// 1-Shot launch flow
// ---------------------------------------------------------------------------
test.describe("1-Shot launch flow", () => {
  test("clicking Run invokes run_oneshot with correct arguments", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: (args: Record<string, unknown>) => {
          // Store the captured args on the window for later retrieval
          (window as unknown as Record<string, unknown>).__capturedOneShotArgs =
            args;
          return new Promise(() => {}); // never resolves to keep session running
        },
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Fill the form
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("Add auth");
    await page.locator(".form-section textarea").fill("Implement OAuth2");
    // Change model
    await page
      .locator('.form-section label:has-text("Model") input[type="text"]')
      .fill("");
    await page
      .locator('.form-section label:has-text("Model") input[type="text"]')
      .fill("sonnet");
    // Select "Create branch" merge strategy
    await page.locator('input[type="radio"][value="branch"]').check();

    // Click Run
    await page.getByRole("button", { name: "Run" }).click();

    // Retrieve the captured args from the window object
    const captured = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__capturedOneShotArgs,
    );

    expect(captured).toBeTruthy();
    const args = captured as Record<string, unknown>;
    expect(args.repoId).toBe("repo-1");
    expect(args.title).toBe("Add auth");
    expect(args.prompt).toBe("Implement OAuth2");
    expect(args.model).toBe("sonnet");
    expect(args.mergeStrategy).toBe("branch");
    expect(args.repo).toEqual({
      type: "local",
      path: "/home/user/projects/my-app",
    });
  });

  test("after session starts running, form is hidden and Stop button appears", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: () => new Promise(() => {}), // never resolves
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Verify form is visible before running
    await expect(page.locator(".form-section")).toBeVisible();

    // Fill and run
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("Task");
    await page.locator(".form-section textarea").fill("Do work");
    await page.getByRole("button", { name: "Run" }).click();

    // Emit a session event to trigger the running state in App.svelte
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: {
          repo_id: "repo-1",
          event: {
            kind: "one_shot_started",
            title: "Task",
            merge_strategy: "merge_to_main",
          },
        },
      });
    });

    // The form section should be hidden when running
    await expect(page.locator(".form-section")).not.toBeVisible();

    // The Stop button should appear
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    // The Run button should show "Running..." and be disabled
    await expect(
      page.getByRole("button", { name: "Running..." }),
    ).toBeDisabled();
  });

  test("phase indicator updates as events are emitted", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: () => new Promise(() => {}),
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Fill and run
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("Task");
    await page.locator(".form-section textarea").fill("Do work");
    await page.getByRole("button", { name: "Run" }).click();

    const phaseIndicator = page.locator(".phase-indicator");

    // Helper to emit a session event
    async function emitEvent(eventData: Record<string, unknown>) {
      await page.evaluate((evt) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
        (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "session-event",
          payload: { repo_id: "repo-1", event: evt },
        });
      }, eventData);
    }

    // 1. one_shot_started -> "Starting..."
    await emitEvent({
      kind: "one_shot_started",
      title: "Task",
      merge_strategy: "merge_to_main",
    });
    await expect(phaseIndicator).toBeVisible();
    await expect(phaseIndicator).toContainText("Starting...");

    // 2. design_phase_started -> "Design Phase"
    await emitEvent({ kind: "design_phase_started" });
    await expect(phaseIndicator).toContainText("Design Phase");

    // 3. design_phase_complete -> "Design Complete"
    await emitEvent({ kind: "design_phase_complete" });
    await expect(phaseIndicator).toContainText("Design Complete");

    // 4. implementation_phase_started -> "Implementation Phase"
    await emitEvent({ kind: "implementation_phase_started" });
    await expect(phaseIndicator).toContainText("Implementation Phase");

    // 5. implementation_phase_complete -> "Implementation Complete"
    await emitEvent({ kind: "implementation_phase_complete" });
    await expect(phaseIndicator).toContainText("Implementation Complete");

    // 6. git_finalize_started -> "Finalizing..."
    await emitEvent({ kind: "git_finalize_started" });
    await expect(phaseIndicator).toContainText("Finalizing...");

    // 7. one_shot_complete -> "Complete"
    await emitEvent({ kind: "one_shot_complete" });
    await expect(phaseIndicator).toContainText("Complete");
    await expect(phaseIndicator).toHaveClass(/complete/);
  });

  test("phase indicator shows Failed styling when one_shot_failed event arrives", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: () => new Promise(() => {}),
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Fill and run
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("Task");
    await page.locator(".form-section textarea").fill("Do work");
    await page.getByRole("button", { name: "Run" }).click();

    const phaseIndicator = page.locator(".phase-indicator");

    // Emit start then failure
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: {
          repo_id: "repo-1",
          event: {
            kind: "one_shot_started",
            title: "Task",
            merge_strategy: "merge_to_main",
          },
        },
      });
    });
    await expect(phaseIndicator).toBeVisible();

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: {
          repo_id: "repo-1",
          event: { kind: "design_phase_started" },
        },
      });
    });

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: {
          repo_id: "repo-1",
          event: { kind: "one_shot_failed", reason: "Design timed out" },
        },
      });
    });

    await expect(phaseIndicator).toContainText("Failed");
    await expect(phaseIndicator).toHaveClass(/failed/);
  });

  test("Stop button calls stop_session", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: () => new Promise(() => {}),
        stop_session: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__stopSessionArgs =
            args;
        },
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: /my-app/ }).click();
    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await page.getByRole("button", { name: "1-Shot" }).click();
    await expect(page.locator("h1", { hasText: "1-Shot" })).toBeVisible();

    // Fill and run
    await page
      .locator('.form-section label:has-text("Title") input[type="text"]')
      .fill("Task");
    await page.locator(".form-section textarea").fill("Do work");
    await page.getByRole("button", { name: "Run" }).click();

    // Emit event to set running state
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: {
          repo_id: "repo-1",
          event: {
            kind: "one_shot_started",
            title: "Task",
            merge_strategy: "merge_to_main",
          },
        },
      });
    });

    // Wait for the Stop button to appear
    const stopButton = page.getByRole("button", { name: "Stop" });
    await expect(stopButton).toBeVisible();

    // Click Stop
    await stopButton.click();

    // Verify stop_session was called with the correct repo ID
    const stopArgs = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__stopSessionArgs,
    );
    expect(stopArgs).toBeTruthy();
    expect((stopArgs as Record<string, unknown>).repoId).toBe("repo-1");
  });
});
