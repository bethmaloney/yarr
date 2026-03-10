import { test, expect } from "./fixtures";

test.describe("Add repo flow", () => {
  test("clicking Add repo shows Local and SSH choices", async ({
    tauriPage: page,
  }) => {
    await page.getByRole("button", { name: "+ Add repo" }).click();

    // Should show an intermediate step with Local and SSH options
    await expect(page.getByRole("button", { name: "Local" })).toBeVisible();
    await expect(page.getByRole("button", { name: "SSH" })).toBeVisible();
  });

  test("choosing Local triggers the directory picker", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      invokeHandlers: {
        "plugin:dialog|open": () => {
          return "/home/user/projects/local-repo";
        },
      },
    });
    await page.goto("/");

    await page.getByRole("button", { name: "+ Add repo" }).click();
    await page.getByRole("button", { name: "Local" }).click();

    // After choosing Local, the directory picker should have been invoked
    // and the repo should appear in the list
    await expect(
      page.getByRole("button", { name: /local-repo/ }),
    ).toBeVisible();
  });

  test("choosing SSH shows host and path inputs", async ({
    tauriPage: page,
  }) => {
    await page.getByRole("button", { name: "+ Add repo" }).click();
    await page.getByRole("button", { name: "SSH" }).click();

    // Should show SSH-specific input fields
    await expect(page.getByLabel("SSH Host")).toBeVisible();
    await expect(page.getByLabel("Remote Path")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible();
  });

  test("filling SSH fields and clicking Add creates the repo", async ({
    tauriPage: page,
  }) => {
    await page.getByRole("button", { name: "+ Add repo" }).click();
    await page.getByRole("button", { name: "SSH" }).click();

    await page.getByLabel("SSH Host").fill("dev-server");
    await page.getByLabel("Remote Path").fill("/home/user/projects/remote-app");
    await page.getByRole("button", { name: "Add" }).click();

    // The SSH repo should now appear in the repo list
    await expect(
      page.getByRole("button", { name: /remote-app/ }),
    ).toBeVisible();
  });
});

test.describe("RepoDetail for SSH repos", () => {
  const sshRepo = {
    type: "ssh" as const,
    id: "ssh-repo-1",
    sshHost: "dev-server",
    remotePath: "/home/user/projects/remote-app",
    name: "remote-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
  };

  test("shows SSH host and remote path in the header", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [sshRepo] } });
    await page.goto("/");

    await page.getByRole("button", { name: /remote-app/ }).click();

    // Header should show repo name
    await expect(page.locator("h1", { hasText: "remote-app" })).toBeVisible();
    // Path area should show the SSH host:remotePath format
    await expect(
      page.getByText("dev-server:/home/user/projects/remote-app"),
    ).toBeVisible();
  });

  test("settings section shows SSH host and remote path as read-only", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [sshRepo] } });
    await page.goto("/");

    await page.getByRole("button", { name: /remote-app/ }).click();

    // Expand the settings section
    await page
      .locator(".settings")
      .locator('[data-slot="collapsible-trigger"]')
      .click();

    // Settings section should display SSH host and remote path
    await expect(page.getByText("SSH Host")).toBeVisible();
    await expect(page.getByText("dev-server")).toBeVisible();
    await expect(page.getByText("Remote Path")).toBeVisible();
    await expect(
      page.getByText("/home/user/projects/remote-app"),
    ).toBeVisible();
  });

  test("shows Test Connection button for SSH repos", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [sshRepo] } });
    await page.goto("/");

    await page.getByRole("button", { name: /remote-app/ }).click();

    // Expand the settings section
    await page
      .locator(".settings")
      .locator('[data-slot="collapsible-trigger"]')
      .click();

    await expect(
      page.getByRole("button", { name: "Test Connection" }),
    ).toBeVisible();
  });
});

test.describe("RepoDetail for Local repos", () => {
  const localRepo = {
    type: "local" as const,
    id: "local-repo-1",
    path: "/home/user/projects/my-app",
    name: "my-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
  };

  test("does not show Test Connection button for local repos", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({ storeData: { repos: [localRepo] } });
    await page.goto("/");

    await page.getByRole("button", { name: /my-app/ }).click();

    // Expand settings to verify Test Connection is truly absent, not just hidden
    await page
      .locator(".settings")
      .locator('[data-slot="collapsible-trigger"]')
      .click();

    // Local repos should not have the Test Connection button
    await expect(
      page.getByRole("button", { name: "Test Connection" }),
    ).not.toBeVisible();
  });

  test("shows the local path in the header", async ({ page, mockTauri }) => {
    await mockTauri({ storeData: { repos: [localRepo] } });
    await page.goto("/");

    await page.getByRole("button", { name: /my-app/ }).click();

    await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
    await expect(page.getByText("/home/user/projects/my-app")).toBeVisible();
  });
});

test.describe("Disconnected and Reconnecting states", () => {
  const sshRepo = {
    type: "ssh" as const,
    id: "ssh-repo-1",
    sshHost: "dev-server",
    remotePath: "/home/user/projects/remote-app",
    name: "remote-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
  };

  async function startRunningSession(
    page: import("@playwright/test").Page,
    mockTauri: (opts?: import("./fixtures").TauriMockOptions) => Promise<void>,
    extraInvokeHandlers: Record<string, unknown> = {},
  ) {
    await mockTauri({
      storeData: { repos: [sshRepo] },
      invokeHandlers: {
        // run_session never resolves, simulating an ongoing session
        run_session: () => new Promise(() => {}),
        ...extraInvokeHandlers,
      },
    });
    await page.goto("/");

    // Navigate to repo detail
    await page.getByRole("button", { name: /remote-app/ }).click();
    await expect(page.locator("h1", { hasText: "remote-app" })).toBeVisible();

    // Fill in plan file and click Run to start the session
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("/tmp/plan.md");
    await page.getByRole("button", { name: "Run", exact: true }).click();

    // Verify session is running
    await expect(page.getByText("Running...")).toBeVisible();
  }

  async function emitSessionEvent(
    page: import("@playwright/test").Page,
    event: Record<string, unknown>,
  ) {
    await page.evaluate((evt) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "session-event",
        payload: { repo_id: "ssh-repo-1", event: evt },
      });
    }, event);
  }

  test("shows Reconnect button when session is disconnected", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Emit a disconnected event
    await emitSessionEvent(page, { kind: "disconnected", iteration: 3 });

    // A Reconnect button should appear
    await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  test("shows reconnecting spinner when reconnecting", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Emit a reconnecting event
    await emitSessionEvent(page, { kind: "reconnecting", iteration: 3 });

    // Should show reconnecting indicator text
    await expect(page.getByText("Reconnecting...")).toBeVisible();
  });

  test("Reconnect button invokes reconnect_session with repoId", async ({
    page,
    mockTauri,
  }) => {
    await mockTauri({
      storeData: { repos: [sshRepo] },
      invokeHandlers: {
        run_session: () => new Promise(() => {}),
        reconnect_session: (args: Record<string, unknown>) => {
          // Store the call args on window so the test can read them
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((window as any).__reconnectCalls ??= []).push(args);
          return Promise.resolve();
        },
      },
    });
    await page.goto("/");

    // Navigate to repo detail
    await page.getByRole("button", { name: /remote-app/ }).click();
    await expect(page.locator("h1", { hasText: "remote-app" })).toBeVisible();

    // Fill in plan file and click Run
    await page
      .getByPlaceholder("docs/plans/my-feature-design.md")
      .fill("/tmp/plan.md");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("Running...")).toBeVisible();

    // Emit disconnected event
    await emitSessionEvent(page, { kind: "disconnected", iteration: 3 });

    // Click Reconnect
    const reconnectButton = page.getByRole("button", { name: "Reconnect" });
    await expect(reconnectButton).toBeVisible();
    await reconnectButton.click();

    // Verify the reconnect_session command was invoked with the correct repoId
    const calls = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__reconnectCalls;
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.objectContaining({ repoId: "ssh-repo-1" }));
  });

  test("disconnect banner shows reason when provided", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Emit a disconnected event with a reason
    await emitSessionEvent(page, {
      kind: "disconnected",
      reason: "SSH connection timed out",
    });

    // Banner should show the reason
    await expect(
      page.getByText("Connection lost: SSH connection timed out"),
    ).toBeVisible();

    // Should still show the "remote session may still be running" text
    await expect(
      page.getByText("the remote session may still be running"),
    ).toBeVisible();
  });

  test("disconnect banner shows fallback when no reason", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Emit a disconnected event without a reason
    await emitSessionEvent(page, { kind: "disconnected" });

    // Banner should show the fallback text without a colon
    await expect(
      page.getByText("Connection lost", { exact: true }),
    ).toBeVisible();

    // Should still show the "remote session may still be running" text
    await expect(
      page.getByText("the remote session may still be running"),
    ).toBeVisible();
  });

  test("disconnect reason is cleared on reconnect", async ({
    page,
    mockTauri,
  }) => {
    await startRunningSession(page, mockTauri);

    // Emit a disconnected event with a reason
    await emitSessionEvent(page, {
      kind: "disconnected",
      reason: "SSH connection timed out",
    });

    // Verify the reason is shown
    await expect(
      page.getByText("Connection lost: SSH connection timed out"),
    ).toBeVisible();

    // Emit a reconnecting event
    await emitSessionEvent(page, { kind: "reconnecting" });

    // The disconnect banner with the reason should no longer be visible
    await expect(
      page.getByText("Connection lost: SSH connection timed out"),
    ).not.toBeVisible();
  });
});

test.describe("Connection test checklist", () => {
  const sshRepo = {
    type: "ssh" as const,
    id: "ssh-repo-1",
    sshHost: "dev-server",
    remotePath: "/home/user/projects/remote-app",
    name: "remote-app",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
  };

  const stepNames = [
    "SSH reachable",
    "tmux available",
    "claude available",
    "Remote path exists",
  ];

  async function emitSshTestStep(
    page: import("@playwright/test").Page,
    step: string,
    status: "pass" | "fail",
    error?: string,
  ) {
    await page.evaluate(
      ({ step, status, error }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
          event: "ssh-test-step",
          payload: { step, status, error: error ?? null },
        });
      },
      { step, status, error },
    );
  }

  async function emitSshTestComplete(page: import("@playwright/test").Page) {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: "ssh-test-complete",
        payload: {},
      });
    });
  }

  async function navigateAndOpenSettings(
    page: import("@playwright/test").Page,
    mockTauri: (opts?: import("./fixtures").TauriMockOptions) => Promise<void>,
  ) {
    await mockTauri({
      storeData: { repos: [sshRepo] },
      invokeHandlers: {
        test_ssh_connection_steps: () => Promise.resolve(),
      },
    });
    await page.goto("/");

    await page.getByRole("button", { name: /remote-app/ }).click();
    await page
      .locator(".settings")
      .locator('[data-slot="collapsible-trigger"]')
      .click();
  }

  test("clicking Test Connection shows checklist with step names", async ({
    page,
    mockTauri,
  }) => {
    await navigateAndOpenSettings(page, mockTauri);

    await page.getByRole("button", { name: "Test Connection" }).click();

    // All 4 step names should be visible in the checklist
    for (const name of stepNames) {
      await expect(page.getByText(name)).toBeVisible();
    }
  });

  test("all steps pass shows checkmarks", async ({ page, mockTauri }) => {
    await navigateAndOpenSettings(page, mockTauri);

    await page.getByRole("button", { name: "Test Connection" }).click();

    // Emit all 4 steps as passing
    for (const name of stepNames) {
      await emitSshTestStep(page, name, "pass");
    }
    await emitSshTestComplete(page);

    // All steps should show pass status
    const checklist = page.getByTestId("connection-checklist");
    for (const name of stepNames) {
      const stepItem = checklist.locator(`:has-text("${name}")`).first();
      await expect(stepItem).toHaveClass(/step-pass/);
    }
  });

  test("failed step shows error and subsequent steps stay pending", async ({
    page,
    mockTauri,
  }) => {
    await navigateAndOpenSettings(page, mockTauri);

    await page.getByRole("button", { name: "Test Connection" }).click();

    // First step passes
    await emitSshTestStep(page, "SSH reachable", "pass");
    // Second step fails with an error
    await emitSshTestStep(
      page,
      "tmux available",
      "fail",
      "tmux: command not found",
    );
    await emitSshTestComplete(page);

    const checklist = page.getByTestId("connection-checklist");

    // First step should show pass
    const firstStep = checklist.locator(`:has-text("SSH reachable")`).first();
    await expect(firstStep).toHaveClass(/step-pass/);

    // Second step should show fail
    const secondStep = checklist.locator(`:has-text("tmux available")`).first();
    await expect(secondStep).toHaveClass(/step-fail/);

    // The error message should be visible
    await expect(page.getByText("tmux: command not found")).toBeVisible();

    // Third and fourth steps should remain pending
    const thirdStep = checklist
      .locator(`:has-text("claude available")`)
      .first();
    await expect(thirdStep).toHaveClass(/step-pending/);

    const fourthStep = checklist
      .locator(`:has-text("Remote path exists")`)
      .first();
    await expect(fourthStep).toHaveClass(/step-pending/);
  });

  test("Test Connection button is disabled while running", async ({
    page,
    mockTauri,
  }) => {
    await navigateAndOpenSettings(page, mockTauri);

    const testButton = page.getByRole("button", { name: "Test Connection" });

    // Button should be enabled before clicking
    await expect(testButton).toBeEnabled();

    await testButton.click();

    // Button should be disabled while test is running
    await expect(testButton).toBeDisabled();

    // Emit all steps and complete
    for (const name of stepNames) {
      await emitSshTestStep(page, name, "pass");
    }
    await emitSshTestComplete(page);

    // Button should be re-enabled after test completes
    await expect(testButton).toBeEnabled();
  });
});
