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
      list_plans: () => ["feature.md"],
      ...extra?.invokeHandlers,
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Helper: select a plan file via the plan selector dropdown
// ---------------------------------------------------------------------------
async function selectPlanFile(page: import("@playwright/test").Page) {
  // Click the plan selector button to open the dropdown
  await page.getByRole("button", { name: "Select a plan" }).click();
  // Click the plan file in the command list
  await page.getByRole("option", { name: "feature.md" }).click();
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
// Tests
// ---------------------------------------------------------------------------
test.describe("Session lifecycle", () => {
  test("start session: Run button changes to Running, Stop button appears", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      invokeHandlers: {
        run_session: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__capturedRunSessionArgs =
            args;
          return { session_id: "sess-123" };
        },
      },
    });

    // Select a plan file so Run button is enabled
    await selectPlanFile(page);

    // Click Run
    await page.getByRole("button", { name: "Run" }).click();

    // Verify "Running..." button appears and is disabled
    const runningBtn = page.getByRole("button", { name: "Running..." });
    await expect(runningBtn).toBeVisible();
    await expect(runningBtn).toBeDisabled();

    // Verify Stop button appears
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 2. Session events flow to UI in real-time
  // ---------------------------------------------------------------------------
  test("session events flow to UI in real-time", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      invokeHandlers: {
        run_session: () => ({ session_id: "sess-123" }),
      },
    });

    // Start a session
    await selectPlanFile(page);
    await page.getByRole("button", { name: "Run" }).click();
    await expect(
      page.getByRole("button", { name: "Running..." }),
    ).toBeVisible();

    // Emit session_started event
    await emitSessionEvent(page, "repo-1", {
      kind: "session_started",
      session_id: "sess-123",
    });

    // Verify event appears in the events list
    const eventsList = page.locator(".events");
    await expect(eventsList).toBeVisible();
    await expect(eventsList.locator("li.session_started")).toBeVisible();

    // Emit iteration_started event
    await emitSessionEvent(page, "repo-1", {
      kind: "iteration_started",
      iteration: 1,
    });

    // Verify iteration event appears (use exact text to avoid matching both
    // the iteration group header and the event line)
    await expect(
      eventsList.getByText("Iteration 1 started"),
    ).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 3. Stop session
  // ---------------------------------------------------------------------------
  test("stop session: calls stop_session, session_complete resets UI", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      invokeHandlers: {
        run_session: () => ({ session_id: "sess-123" }),
        stop_session: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__stopSessionArgs =
            args;
        },
      },
    });

    // Start a session
    await selectPlanFile(page);
    await page.getByRole("button", { name: "Run" }).click();
    await expect(
      page.getByRole("button", { name: "Running..." }),
    ).toBeVisible();

    // Emit session_started so events list appears
    await emitSessionEvent(page, "repo-1", {
      kind: "session_started",
      session_id: "sess-123",
    });

    // Click Stop
    const stopBtn = page.getByRole("button", { name: "Stop" });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();

    // Verify stop_session was called with the correct repoId
    const stopArgs = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown>).__stopSessionArgs,
    );
    expect(stopArgs).toBeTruthy();
    expect((stopArgs as Record<string, unknown>).repoId).toBe("repo-1");

    // Emit session_complete event — this should reset the UI
    await emitSessionEvent(page, "repo-1", {
      kind: "session_complete",
      outcome: "completed",
    });

    // Verify Run button re-enables (shows "Run" again, not "Running...")
    await expect(page.getByRole("button", { name: "Run" })).toBeVisible();

    // Verify Stop button disappears
    await expect(
      page.getByRole("button", { name: "Stop" }),
    ).not.toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // 4. Reject duplicate session
  // ---------------------------------------------------------------------------
  test("reject duplicate session: shows error", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      invokeHandlers: {
        run_session: () => {
          throw new Error("Session already running for this repo");
        },
      },
    });

    // Select plan file and click Run
    await selectPlanFile(page);
    await page.getByRole("button", { name: "Run" }).click();

    // Verify error section appears with the error message
    const errorSection = page.locator(
      "section",
      { has: page.locator("h2", { hasText: "Error" }) },
    );
    await expect(errorSection).toBeVisible();
    await expect(errorSection.locator("h2")).toHaveText("Error");
    await expect(errorSection.locator("pre")).toContainText(
      "Session already running for this repo",
    );

    // Verify Run button is re-enabled (not stuck in running state)
    const runBtn = page.getByRole("button", { name: "Run" });
    await expect(runBtn).toBeVisible();
    await expect(runBtn).toBeEnabled();
  });

  // ---------------------------------------------------------------------------
  // 5. session_complete triggers trace fetch
  // ---------------------------------------------------------------------------
  test("session_complete triggers trace fetch", async ({
    page,
    mockTauri,
  }) => {
    const mockTrace = {
      session_id: "sess-123",
      repo_path: "/home/user/projects/my-app",
      repo_id: "repo-1",
      prompt: "Fix the bug",
      plan_file: "docs/plans/feature.md",
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      outcome: "completed",
      total_iterations: 2,
      total_cost_usd: 0.15,
      total_input_tokens: 10000,
      total_output_tokens: 5000,
      total_cache_read_tokens: 2000,
      total_cache_creation_tokens: 1000,
    };

    await navigateToRepoDetail(page, mockTauri, {
      invokeHandlers: {
        run_session: () => ({ session_id: "sess-123" }),
        get_trace: (args: Record<string, unknown>) => {
          (window as unknown as Record<string, unknown>).__getTraceArgs =
            args;
          return mockTrace;
        },
      },
    });

    // Start a session
    await selectPlanFile(page);
    await page.getByRole("button", { name: "Run" }).click();
    await expect(
      page.getByRole("button", { name: "Running..." }),
    ).toBeVisible();

    // Emit session_complete event
    await emitSessionEvent(page, "repo-1", {
      kind: "session_complete",
      outcome: "completed",
    });

    // Wait for get_trace to be called and verify args
    await expect(async () => {
      const traceArgs = await page.evaluate(
        () =>
          (window as unknown as Record<string, unknown>).__getTraceArgs,
      );
      expect(traceArgs).toBeTruthy();
      expect((traceArgs as Record<string, unknown>).repoId).toBe("repo-1");
      expect((traceArgs as Record<string, unknown>).sessionId).toBe(
        "sess-123",
      );
    }).toPass({ timeout: 5000 });
  });
});
