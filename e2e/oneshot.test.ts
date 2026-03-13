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

// ---------------------------------------------------------------------------
// Helper: navigate to the RepoDetail page for "my-app"
// ---------------------------------------------------------------------------
async function navigateToRepoDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  extra?: {
    invokeHandlers?: Record<string, unknown>;
    storeData?: Record<string, unknown>;
  },
) {
  await mockTauri({
    storeData: { ...repoStoreData, ...extra?.storeData },
    invokeHandlers: {
      get_active_sessions: () => [],
      run_oneshot: () => new Promise(() => {}),
      ...extra?.invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Helper: open the inline 1-shot form on the RepoDetail page
// ---------------------------------------------------------------------------
async function openOneShotForm(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  extra?: {
    invokeHandlers?: Record<string, unknown>;
    storeData?: Record<string, unknown>;
  },
) {
  await navigateToRepoDetail(page, mockTauri, extra);
  await page.getByRole("button", { name: "1-Shot" }).click();
  await expect(page.locator("#oneshot-title")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Helper: emit a session event via the Tauri mock
// ---------------------------------------------------------------------------
async function emitSessionEvent(
  page: import("@playwright/test").Page,
  repoId: string,
  eventData: Record<string, unknown>,
) {
  await page.evaluate(
    ({ repoId, evt }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: { repo_id: repoId, event: evt },
      });
    },
    { repoId, evt: eventData },
  );
}

// ---------------------------------------------------------------------------
// 1. 1-Shot form on RepoDetail
// ---------------------------------------------------------------------------
test.describe("1-Shot form on RepoDetail", () => {
  test('"1-Shot" button is visible', async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);
    await expect(page.getByRole("button", { name: "1-Shot" })).toBeVisible();
  });

  test('clicking "1-Shot" opens the inline form', async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri);
    await page.getByRole("button", { name: "1-Shot" }).click();

    await expect(page.getByText("Title", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt", { exact: true })).toBeVisible();
    await expect(page.getByText("Model", { exact: true })).toBeVisible();
    await expect(page.getByText("Merge Strategy")).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
  });

  test("Cancel button closes the form", async ({ page, mockTauri }) => {
    await openOneShotForm(page, mockTauri);

    await page.getByRole("button", { name: "Cancel" }).click();

    await expect(page.locator("#oneshot-title")).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Launch" }),
    ).not.toBeVisible();
  });

  test("Model field is pre-filled with repo default model", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    await expect(page.locator("#oneshot-model")).toHaveValue("opus");
  });

  test("Launch button disabled when title empty", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    await page.locator("#oneshot-prompt").fill("Do something");

    await expect(page.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  test("Launch button disabled when prompt empty", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    await page.locator("#oneshot-title").fill("My Task");

    await expect(page.getByRole("button", { name: "Launch" })).toBeDisabled();
  });

  test("Launch button enabled when both title and prompt filled", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    await page.locator("#oneshot-title").fill("My Task");
    await page.locator("#oneshot-prompt").fill("Do something important");

    await expect(page.getByRole("button", { name: "Launch" })).toBeEnabled();
  });

  test("Merge strategy defaults to merge_to_main", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri);

    const mergeToMainRadio = page.locator(
      'input[type="radio"][value="merge_to_main"]',
    );
    await expect(mergeToMainRadio).toBeChecked();

    const branchRadio = page.locator('input[type="radio"][value="branch"]');
    await expect(branchRadio).not.toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// 2. 1-Shot launch from RepoDetail
// ---------------------------------------------------------------------------
test.describe("1-Shot launch from RepoDetail", () => {
  test("clicking Launch invokes run_oneshot with correct args", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri, {
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedArgs = args;
          return { oneshot_id: "oneshot-abc123", trace: null };
        },
      },
    });

    await page.locator("#oneshot-title").fill("Add auth");
    await page.locator("#oneshot-prompt").fill("Implement OAuth2");
    await page.locator("#oneshot-model").fill("");
    await page.locator("#oneshot-model").fill("sonnet");
    await page.locator('input[type="radio"][value="branch"]').check();

    await page.getByRole("button", { name: "Launch" }).click();

    const captured = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__capturedArgs,
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
    // Verify repo config is forwarded to the 1-shot backend
    expect(args.maxIterations).toBe(40);
    expect(args.completionSignal).toBe("ALL TODO ITEMS COMPLETE");
  });

  test("after launch, navigates to OneShotDetail page", async ({
    page,
    mockTauri,
  }) => {
    await openOneShotForm(page, mockTauri, {
      invokeHandlers: {
        get_active_sessions: () => [],
        run_oneshot: () => {
          return { oneshot_id: "oneshot-abc123", trace: null };
        },
      },
    });

    await page.locator("#oneshot-title").fill("Add auth");
    await page.locator("#oneshot-prompt").fill("Implement OAuth2");

    await page.getByRole("button", { name: "Launch" }).click();

    await page.waitForURL(/\/oneshot\/oneshot-abc123/);
    await expect(page.locator("h1", { hasText: "Add auth" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 3. 1-Shot card on Home page
// ---------------------------------------------------------------------------
test.describe("1-Shot card on Home page", () => {
  const oneshotEntry = {
    id: "oneshot-xyz",
    parentRepoId: "repo-1",
    parentRepoName: "my-app",
    title: "Fix the bug",
    prompt: "Find and fix the null pointer bug",
    model: "opus",
    mergeStrategy: "merge_to_main",
    status: "running" as const,
    startedAt: Date.now(),
  };

  test("shows a 1-shot card with title and 1-Shot badge", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [["oneshot-xyz", oneshotEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", {
      name: "Fix the bug \u2014 1-Shot",
    });
    await expect(card).toBeVisible();
    await expect(card).toContainText("1-Shot");
  });

  test("clicking 1-shot card navigates to OneShotDetail", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [["oneshot-xyz", oneshotEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/");

    await page
      .getByRole("button", { name: "Fix the bug \u2014 1-Shot" })
      .click();

    await page.waitForURL(/\/oneshot\/oneshot-xyz/);
  });

  test("failed entry card has a Dismiss button that removes the card", async ({
    page,
    mockTauri,
  }) => {
    const failedEntry = { ...oneshotEntry, status: "failed" as const };
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [["oneshot-xyz", failedEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/");

    const card = page.getByRole("button", {
      name: "Fix the bug \u2014 1-Shot",
    });
    await expect(card).toBeVisible();

    const dismissBtn = page.getByRole("button", { name: "Dismiss" });
    await expect(dismissBtn).toBeVisible();

    await dismissBtn.click();

    await expect(card).not.toBeVisible();
  });

  test("cards appear alongside repo cards", async ({ page, mockTauri }) => {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [["oneshot-xyz", oneshotEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/");

    await expect(page.getByRole("button", { name: /my-app/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Fix the bug \u2014 1-Shot" }),
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. OneShotDetail page - active mode
// ---------------------------------------------------------------------------
test.describe("OneShotDetail page - active mode", () => {
  const oneshotId = "oneshot-abc123";
  const oneshotEntry = {
    id: oneshotId,
    parentRepoId: "repo-1",
    parentRepoName: "my-app",
    title: "Add auth feature",
    prompt: "Implement OAuth2 authentication flow",
    model: "opus",
    mergeStrategy: "merge_to_main",
    status: "running" as const,
    startedAt: Date.now(),
  };

  async function setupOneShotDetail(
    page: import("@playwright/test").Page,
    mockTauri: (opts?: TauriMockOptions) => Promise<void>,
    invokeHandlers?: Record<string, unknown>,
  ) {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, oneshotEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [[oneshotId, "session-123"]],
        ...invokeHandlers,
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);
  }

  test("shows entry title, parent repo name, and prompt text", async ({
    page,
    mockTauri,
  }) => {
    await setupOneShotDetail(page, mockTauri);

    await expect(
      page.locator("h1", { hasText: "Add auth feature" }),
    ).toBeVisible();
    await expect(page.getByText("from my-app")).toBeVisible();
    await expect(
      page.getByText("Implement OAuth2 authentication flow"),
    ).toBeVisible();
  });

  test("phase indicator updates as events arrive", async ({
    page,
    mockTauri,
  }) => {
    await setupOneShotDetail(page, mockTauri);

    const phaseIndicator = page.locator(".phase-indicator");

    // 1. one_shot_started -> "Starting..."
    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_started",
      title: "Add auth feature",
      merge_strategy: "merge_to_main",
      worktree_path: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    });
    await expect(phaseIndicator).toBeVisible();
    await expect(phaseIndicator).toContainText("Starting...");

    // 2. design_phase_started -> "Design Phase"
    await emitSessionEvent(page, oneshotId, { kind: "design_phase_started" });
    await expect(phaseIndicator).toContainText("Design Phase");

    // 3. design_phase_complete -> "Design Complete"
    await emitSessionEvent(page, oneshotId, { kind: "design_phase_complete" });
    await expect(phaseIndicator).toContainText("Design Complete");

    // 4. implementation_phase_started -> "Implementation Phase"
    await emitSessionEvent(page, oneshotId, {
      kind: "implementation_phase_started",
    });
    await expect(phaseIndicator).toContainText("Implementation Phase");

    // 5. implementation_phase_complete -> "Implementation Complete"
    await emitSessionEvent(page, oneshotId, {
      kind: "implementation_phase_complete",
    });
    await expect(phaseIndicator).toContainText("Implementation Complete");

    // 6. git_finalize_started -> "Finalizing..."
    await emitSessionEvent(page, oneshotId, { kind: "git_finalize_started" });
    await expect(phaseIndicator).toContainText("Finalizing...");

    // 7. one_shot_complete -> "Complete"
    await emitSessionEvent(page, oneshotId, { kind: "one_shot_complete" });
    await expect(phaseIndicator).toContainText("Complete");
    await expect(phaseIndicator).toHaveClass(/complete/);
  });

  test("phase indicator shows Failed styling on one_shot_failed", async ({
    page,
    mockTauri,
  }) => {
    await setupOneShotDetail(page, mockTauri);

    const phaseIndicator = page.locator(".phase-indicator");

    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_started",
      title: "Add auth feature",
      merge_strategy: "merge_to_main",
      worktree_path: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    });
    await expect(phaseIndicator).toBeVisible();

    await emitSessionEvent(page, oneshotId, { kind: "design_phase_started" });

    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_failed",
      reason: "Design timed out",
    });
    await expect(phaseIndicator).toContainText("Failed");
    await expect(phaseIndicator).toHaveClass(/failed/);
  });

  test("Stop button visible when running; calls stop_session with oneshotId", async ({
    page,
    mockTauri,
  }) => {
    await setupOneShotDetail(page, mockTauri, {
      get_active_sessions: () => [[oneshotId, "session-123"]],
      stop_session: (args: Record<string, unknown>) => {
        (window as unknown as Record<string, unknown>).__stopSessionArgs = args;
      },
    });

    // Emit an event so the session is recognized as running
    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_started",
      title: "Add auth feature",
      merge_strategy: "merge_to_main",
      worktree_path: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    });

    const stopButton = page.getByRole("button", { name: "Stop" });
    await expect(stopButton).toBeVisible();

    await stopButton.click();

    const stopArgs = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__stopSessionArgs,
    );
    expect(stopArgs).toBeTruthy();
    expect((stopArgs as Record<string, unknown>).repoId).toBe(oneshotId);
  });
});

// ---------------------------------------------------------------------------
// 5. OneShotDetail page - completed/read-only mode
// ---------------------------------------------------------------------------
test.describe("OneShotDetail page - completed/read-only mode", () => {
  const oneshotId = "oneshot-done456";
  const completedEntry = {
    id: oneshotId,
    parentRepoId: "repo-1",
    parentRepoName: "my-app",
    title: "Completed task",
    prompt: "This task is done",
    model: "opus",
    mergeStrategy: "merge_to_main",
    status: "completed" as const,
    startedAt: Date.now() - 60000,
  };

  test("shows completed phase and no Stop button", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, completedEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Completed task" }),
    ).toBeVisible();

    // Emit events to simulate a completed session
    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_started",
      title: "Completed task",
      merge_strategy: "merge_to_main",
      worktree_path: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    });
    await emitSessionEvent(page, oneshotId, { kind: "design_phase_started" });
    await emitSessionEvent(page, oneshotId, { kind: "design_phase_complete" });
    await emitSessionEvent(page, oneshotId, {
      kind: "implementation_phase_started",
    });
    await emitSessionEvent(page, oneshotId, {
      kind: "implementation_phase_complete",
    });
    await emitSessionEvent(page, oneshotId, { kind: "one_shot_complete" });

    // Mark session as no longer running
    await emitSessionEvent(page, oneshotId, {
      kind: "session_complete",
      outcome: "completed",
    });

    const phaseIndicator = page.locator(".phase-indicator");
    await expect(phaseIndicator).toContainText("Complete");
    await expect(phaseIndicator).toHaveClass(/complete/);

    // Stop button should NOT be visible (session stopped after session_complete)
    await expect(page.getByRole("button", { name: "Stop" })).not.toBeVisible();
  });

  test("shows error section when session has an error", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, completedEntry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Completed task" }),
    ).toBeVisible();

    // Emit events to trigger failure path
    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_started",
      title: "Completed task",
      merge_strategy: "merge_to_main",
      worktree_path: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    });
    await emitSessionEvent(page, oneshotId, {
      kind: "one_shot_failed",
      reason: "Something went wrong",
    });

    const phaseIndicator = page.locator(".phase-indicator");
    await expect(phaseIndicator).toContainText("Failed");
    await expect(phaseIndicator).toHaveClass(/failed/);
  });
});

// ---------------------------------------------------------------------------
// 6. OneShotDetail - not found
// ---------------------------------------------------------------------------
test.describe("OneShotDetail - not found", () => {
  test('shows "Not found" for nonexistent oneshotId', async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: repoStoreData,
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto("/oneshot/nonexistent");

    await expect(page.getByText("Not found")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 7. OneShotDetail - empty state
// ---------------------------------------------------------------------------
test.describe("OneShotDetail - empty state", () => {
  const oneshotId = "oneshot-empty-1";

  test('shows "Session starting..." when status is running with no events', async ({
    page,
    mockTauri,
  }) => {
    const entry = {
      id: oneshotId,
      parentRepoId: "repo-1",
      parentRepoName: "my-app",
      title: "Starting task",
      prompt: "Do something",
      model: "opus",
      mergeStrategy: "merge_to_main",
      status: "running" as const,
      startedAt: Date.now(),
    };

    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, entry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Starting task" }),
    ).toBeVisible();
    await expect(page.getByText("Session starting...")).toBeVisible();
  });

  test('shows "Session was interrupted" with Resume button when failed with worktreePath', async ({
    page,
    mockTauri,
  }) => {
    const entry = {
      id: oneshotId,
      parentRepoId: "repo-1",
      parentRepoName: "my-app",
      title: "Interrupted task",
      prompt: "Do something",
      model: "opus",
      mergeStrategy: "merge_to_main",
      status: "failed" as const,
      startedAt: Date.now(),
      worktreePath: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    };

    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, entry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Interrupted task" }),
    ).toBeVisible();
    await expect(page.getByText("Session was interrupted")).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  });

  test('shows "Session failed before starting" when failed without worktreePath', async ({
    page,
    mockTauri,
  }) => {
    const entry = {
      id: oneshotId,
      parentRepoId: "repo-1",
      parentRepoName: "my-app",
      title: "Failed task",
      prompt: "Do something",
      model: "opus",
      mergeStrategy: "merge_to_main",
      status: "failed" as const,
      startedAt: Date.now(),
    };

    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, entry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Failed task" }),
    ).toBeVisible();
    await expect(page.getByText("Session failed before starting")).toBeVisible();
  });

  test('shows "No events recorded" when completed with no events', async ({
    page,
    mockTauri,
  }) => {
    const entry = {
      id: oneshotId,
      parentRepoId: "repo-1",
      parentRepoName: "my-app",
      title: "Completed task no events",
      prompt: "Do something",
      model: "opus",
      mergeStrategy: "merge_to_main",
      status: "completed" as const,
      startedAt: Date.now(),
    };

    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, entry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(
      page.locator("h1", { hasText: "Completed task no events" }),
    ).toBeVisible();
    await expect(page.getByText("No events recorded")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 8. OneShotDetail - resume button
// ---------------------------------------------------------------------------
test.describe("OneShotDetail - resume button", () => {
  const oneshotId = "oneshot-resume-1";

  test("clicking Resume calls resume_oneshot with correct args", async ({
    page,
    mockTauri,
  }) => {
    const entry = {
      id: oneshotId,
      parentRepoId: "repo-1",
      parentRepoName: "my-app",
      title: "Interrupted task",
      prompt: "Implement feature X",
      model: "opus",
      mergeStrategy: "merge_to_main",
      status: "failed" as const,
      startedAt: Date.now(),
      worktreePath: "/tmp/worktrees/test-wt",
      branch: "oneshot/test-branch",
    };

    await mockTauri({
      storeData: {
        ...repoStoreData,
        "oneshot-entries": [[oneshotId, entry]],
      },
      invokeHandlers: {
        get_active_sessions: () => [],
        resume_oneshot: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedArgs = args;
          return { oneshot_id: oneshotId, session_id: "new-sess-456" };
        },
      },
    });
    await page.goto(`/oneshot/${oneshotId}`);

    await expect(page.getByText("Session was interrupted")).toBeVisible();

    const resumeBtn = page.getByRole("button", { name: "Resume" });
    await expect(resumeBtn).toBeVisible();
    await resumeBtn.click();

    const captured = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__capturedArgs,
    );

    expect(captured).toBeTruthy();
    const args = captured as Record<string, unknown>;
    expect(args.oneshotId).toBe(oneshotId);
    expect(args.repoId).toBe("repo-1");
    expect(args.title).toBe("Interrupted task");
    expect(args.prompt).toBe("Implement feature X");
    expect(args.model).toBe("opus");
    expect(args.mergeStrategy).toBe("merge_to_main");
    expect(args.worktreePath).toBe("/tmp/worktrees/test-wt");
    expect(args.branch).toBe("oneshot/test-branch");
    expect(args.repo).toEqual({
      type: "local",
      path: "/home/user/projects/my-app",
    });
  });
});
