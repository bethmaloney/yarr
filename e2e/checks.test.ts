import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const repoWithoutChecks = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
  checks: [],
};

const repoWithOneCheck = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
  checks: [
    {
      name: "clippy",
      command: "cargo clippy --all-targets -- -D warnings",
      when: "each_iteration",
      timeoutSecs: 1200,
      maxRetries: 3,
    },
  ],
};

const repoWithTwoChecks = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
  checks: [
    {
      name: "clippy",
      command: "cargo clippy --all-targets -- -D warnings",
      when: "each_iteration",
      timeoutSecs: 1200,
      maxRetries: 3,
    },
    {
      name: "test",
      command: "cargo test",
      when: "post_completion",
      prompt: "Run full test suite",
      model: "sonnet",
      timeoutSecs: 600,
      maxRetries: 1,
    },
  ],
};

async function navigateToChecksTab(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  storeData?: Record<string, unknown>,
) {
  await mockTauri({ storeData: storeData ?? { repos: [repoWithoutChecks] } });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
  // Open settings sheet
  await page.locator(".settings").click();
  // Navigate to Checks tab
  await page.getByRole("tab", { name: /checks/i }).click();
}

async function navigateToChecksTabWithRunning(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
) {
  await mockTauri({
    storeData: { repos: [repoWithOneCheck] },
    invokeHandlers: {
      run_session: () => new Promise(() => {}), // never resolves
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();

  // Fill in a plan file and click Run to start the session
  await page
    .getByPlaceholder("docs/plans/my-feature-design.md")
    .fill("/tmp/plan.md");
  await page.getByRole("button", { name: "Run", exact: true }).click();

  // Verify session is running
  await expect(page.getByText("Running...")).toBeVisible();

  // Open settings sheet and go to Checks tab
  await page.locator(".settings").click();
  await page.getByRole("tab", { name: /checks/i }).click();
}

test.describe("Checks settings tab", () => {
  test("shows empty state when no checks", async ({ page, mockTauri }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    await expect(page.getByText("No checks configured")).toBeVisible();
    await expect(page.locator(".check-entry")).toHaveCount(0);
  });

  test("shows check entries for pre-existing checks", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    await expect(page.locator(".check-entry")).toHaveCount(1);
  });

  test("add check button creates a new check entry", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    // Initially no check entries
    await expect(page.locator(".check-entry")).toHaveCount(0);

    // Click "Add Check" button
    await page.getByRole("button", { name: "Add Check" }).click();

    // A new check entry should appear
    await expect(page.locator(".check-entry")).toHaveCount(1);
  });

  test("new check has default values", async ({ page, mockTauri }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    await page.getByRole("button", { name: "Add Check" }).click();

    const checkEntry = page.locator(".check-entry").first();

    // Verify default field values
    await expect(checkEntry.getByPlaceholder(/Check \d/)).toHaveValue("");

    const commandInput = checkEntry.getByLabel("Command");
    await expect(commandInput).toHaveValue("");

    const timeoutInput = checkEntry.getByRole("spinbutton", {
      name: /timeout/i,
    });
    await expect(timeoutInput).toHaveValue("300");

    // "Every iteration" should be the active toggle (has primary bg class)
    await expect(
      checkEntry.getByRole("button", { name: /every iteration/i }),
    ).toHaveClass(/bg-primary/);
  });

  test("pre-existing check displays its values", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    const checkEntry = page.locator(".check-entry").first();
    await expect(checkEntry).toBeVisible();

    // Verify the fields are populated with the pre-existing check data
    await expect(checkEntry.getByPlaceholder(/Check \d/)).toHaveValue("clippy");

    const commandInput = checkEntry.getByLabel("Command");
    await expect(commandInput).toHaveValue(
      "cargo clippy --all-targets -- -D warnings",
    );

    const timeoutInput = checkEntry.getByRole("spinbutton", {
      name: /timeout/i,
    });
    await expect(timeoutInput).toHaveValue("1200");

    // "Every iteration" should be active for each_iteration (has primary bg class)
    await expect(
      checkEntry.getByRole("button", { name: /every iteration/i }),
    ).toHaveClass(/bg-primary/);
  });

  test("remove button removes a check", async ({ page, mockTauri }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    await expect(page.locator(".check-entry")).toHaveCount(1);

    // Click the remove button on the check
    const checkEntry = page.locator(".check-entry").first();
    await checkEntry.getByRole("button", { name: "Remove check" }).click();

    // Check entry should be removed
    await expect(page.locator(".check-entry")).toHaveCount(0);
  });

  test("remove only removes the targeted check", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithTwoChecks],
    });

    // Verify two check entries exist
    await expect(page.locator(".check-entry")).toHaveCount(2);

    // Remove the first check (clippy)
    const firstCheckEntry = page.locator(".check-entry").first();
    await firstCheckEntry.getByRole("button", { name: "Remove check" }).click();

    // Only one check should remain
    await expect(page.locator(".check-entry")).toHaveCount(1);

    // The remaining check should be the second one (test)
    const remainingEntry = page.locator(".check-entry").first();
    await expect(remainingEntry.getByPlaceholder(/Check \d/)).toHaveValue(
      "test",
    );
  });
});

test.describe("Checks — On Failure section", () => {
  test("On Failure section expands to show model, prompt, retries", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    await page.getByRole("button", { name: "Add Check" }).click();

    const checkEntry = page.locator(".check-entry").first();

    // Expand "On Failure" collapsible
    await checkEntry.locator('[data-slot="collapsible-trigger"]').click();

    const content = checkEntry.locator('[data-slot="collapsible-content"]');

    // Verify model input, prompt textarea, and retries input are visible
    await expect(
      checkEntry.getByPlaceholder("Inherit from session"),
    ).toBeVisible();
    await expect(
      checkEntry.getByPlaceholder(/Fix all lint errors/),
    ).toBeVisible();
    await expect(
      content.getByRole("spinbutton", { name: /retries/i }),
    ).toBeVisible();
  });

  test("pre-existing check with prompt and model shows values in On Failure", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithTwoChecks],
    });

    // The second check (index 1) has model and prompt set
    const secondCheck = page.locator(".check-entry").nth(1);
    await expect(secondCheck).toBeVisible();

    // Expand "On Failure" on the second check
    await secondCheck.locator('[data-slot="collapsible-trigger"]').click();

    const content = secondCheck.locator('[data-slot="collapsible-content"]');

    // Verify model is "sonnet"
    await expect(
      secondCheck.getByPlaceholder("Inherit from session"),
    ).toHaveValue("sonnet");

    // Verify prompt is "Run full test suite"
    await expect(
      secondCheck.getByPlaceholder(/Fix all lint errors/),
    ).toHaveValue("Run full test suite");

    // Verify retries is 1
    await expect(
      content.getByRole("spinbutton", { name: /retries/i }),
    ).toHaveValue("1");
  });

  test("new check has empty model and prompt in On Failure", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTab(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    await page.getByRole("button", { name: "Add Check" }).click();

    const checkEntry = page.locator(".check-entry").first();

    // Expand "On Failure"
    await checkEntry.locator('[data-slot="collapsible-trigger"]').click();

    // Model should be empty
    await expect(
      checkEntry.getByPlaceholder("Inherit from session"),
    ).toHaveValue("");

    // Prompt should be empty
    await expect(
      checkEntry.getByPlaceholder(/Fix all lint errors/),
    ).toHaveValue("");
  });

  test("On Failure fields disabled while running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTabWithRunning(page, mockTauri);

    const checkEntry = page.locator(".check-entry").first();
    await expect(checkEntry).toBeVisible();

    // Expand "On Failure"
    await checkEntry.locator('[data-slot="collapsible-trigger"]').click();

    const content = checkEntry.locator('[data-slot="collapsible-content"]');

    // All On Failure fields should be disabled
    await expect(
      checkEntry.getByPlaceholder("Inherit from session"),
    ).toBeDisabled();
    await expect(
      checkEntry.getByPlaceholder(/Fix all lint errors/),
    ).toBeDisabled();
    await expect(
      content.getByRole("spinbutton", { name: /retries/i }),
    ).toBeDisabled();
  });
});

test.describe("Checks — disabled while running", () => {
  test("add check button disabled while running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToChecksTabWithRunning(page, mockTauri);

    await expect(
      page.getByRole("button", { name: "Add Check" }),
    ).toBeDisabled();
  });

  test("check fields disabled while running", async ({ page, mockTauri }) => {
    await navigateToChecksTabWithRunning(page, mockTauri);

    const checkEntry = page.locator(".check-entry").first();
    await expect(checkEntry).toBeVisible();

    // Name input disabled
    await expect(checkEntry.getByPlaceholder(/Check \d/)).toBeDisabled();

    // Command input disabled
    await expect(checkEntry.getByLabel("Command")).toBeDisabled();

    // Timeout disabled
    await expect(
      checkEntry.getByRole("spinbutton", { name: /timeout/i }),
    ).toBeDisabled();

    // Remove button disabled
    await expect(
      checkEntry.getByRole("button", { name: "Remove check" }),
    ).toBeDisabled();
  });
});
