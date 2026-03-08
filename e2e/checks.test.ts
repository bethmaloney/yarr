import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const repoWithoutChecks = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
  checks: [],
};

const repoWithOneCheck = {
  id: "repo-1",
  path: "/home/user/projects/my-app",
  name: "my-app",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
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
  completionSignal: "ALL TODO ITEMS COMPLETE",
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

async function navigateToRepoDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  storeData?: Record<string, unknown>,
) {
  await mockTauri({ storeData: storeData ?? { repos: [repoWithoutChecks] } });
  await page.goto("/");
  await page.getByRole("button", { name: /my-app/ }).click();
  await expect(page.locator("h1", { hasText: "my-app" })).toBeVisible();
}

async function navigateToRepoDetailWithRunning(
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
}

test.describe("Checks settings section", () => {
  test("checks section renders with summary", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri);

    const checksDetails = page.locator("details.checks");
    await expect(checksDetails).toBeVisible();

    const summary = checksDetails.locator("summary");
    await expect(summary).toContainText("Checks");
  });

  test("shows 0 configured when no checks exist", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    const checksDetails = page.locator("details.checks");
    const summary = checksDetails.locator("summary");
    await expect(summary).toContainText("Checks");
    await expect(summary).toContainText("0 configured");
  });

  test("shows correct count with 1 pre-existing check", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    const checksDetails = page.locator("details.checks");
    const summary = checksDetails.locator("summary");
    await expect(summary).toContainText("Checks");
    await expect(summary).toContainText("1 configured");
  });

  test("shows correct count with 2 pre-existing checks", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithTwoChecks],
    });

    const checksDetails = page.locator("details.checks");
    const summary = checksDetails.locator("summary");
    await expect(summary).toContainText("2 configured");
  });

  test("add check button creates a new check entry", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // Initially no check entries
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(0);

    // Click "Add Check" button
    await page.getByRole("button", { name: "Add Check" }).click();

    // A new check entry should appear
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(1);

    // Summary should update to show 1 configured
    await expect(checksDetails.locator("summary").first()).toContainText(
      "1 configured",
    );
  });

  test("new check has default values", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithoutChecks],
    });

    // Expand checks section and add a check
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();
    await page.getByRole("button", { name: "Add Check" }).click();

    // Expand the new check entry
    const checkEntry = checksDetails.locator("details.check-entry").first();
    await checkEntry.locator("summary").click();

    // Verify default field values
    const nameInput = checkEntry.getByRole("textbox", { name: /name/i });
    await expect(nameInput).toHaveValue("");

    const commandInput = checkEntry.getByRole("textbox", { name: /command/i });
    await expect(commandInput).toHaveValue("");

    const whenSelect = checkEntry.locator("select");
    await expect(whenSelect).toHaveValue("each_iteration");

    const timeoutInput = checkEntry.getByRole("spinbutton", {
      name: /timeout/i,
    });
    await expect(timeoutInput).toHaveValue("300");

    const retriesInput = checkEntry.getByRole("spinbutton", {
      name: /retries/i,
    });
    await expect(retriesInput).toHaveValue("1");
  });

  test("pre-existing check displays its values", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // Expand the check entry
    const checkEntry = checksDetails.locator("details.check-entry").first();
    await checkEntry.locator("summary").click();

    // Verify the fields are populated with the pre-existing check data
    const nameInput = checkEntry.getByRole("textbox", { name: /name/i });
    await expect(nameInput).toHaveValue("clippy");

    const commandInput = checkEntry.getByRole("textbox", { name: /command/i });
    await expect(commandInput).toHaveValue(
      "cargo clippy --all-targets -- -D warnings",
    );

    const whenSelect = checkEntry.locator("select");
    await expect(whenSelect).toHaveValue("each_iteration");

    const timeoutInput = checkEntry.getByRole("spinbutton", {
      name: /timeout/i,
    });
    await expect(timeoutInput).toHaveValue("1200");

    const retriesInput = checkEntry.getByRole("spinbutton", {
      name: /retries/i,
    });
    await expect(retriesInput).toHaveValue("3");
  });

  test("remove button removes a check", async ({ page, mockTauri }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithOneCheck],
    });

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // Verify one check entry exists
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(1);

    // Click the remove button on the check
    const checkEntry = checksDetails.locator("details.check-entry").first();
    await checkEntry.getByRole("button", { name: "\u00d7" }).click();

    // Check entry should be removed
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(0);

    // Summary should update to show 0 configured
    await expect(checksDetails.locator("summary").first()).toContainText(
      "0 configured",
    );
  });

  test("remove only removes the targeted check", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetail(page, mockTauri, {
      repos: [repoWithTwoChecks],
    });

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // Verify two check entries exist
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(2);

    // Remove the first check (clippy)
    const firstCheckEntry = checksDetails
      .locator("details.check-entry")
      .first();
    await firstCheckEntry.getByRole("button", { name: "\u00d7" }).click();

    // Only one check should remain
    await expect(checksDetails.locator("details.check-entry")).toHaveCount(1);

    // The remaining check should be the second one (test)
    const remainingEntry = checksDetails.locator("details.check-entry").first();
    await remainingEntry.locator("summary").click();
    const nameInput = remainingEntry.getByRole("textbox", { name: /name/i });
    await expect(nameInput).toHaveValue("test");

    // Summary should show 1 configured
    await expect(checksDetails.locator("summary").first()).toContainText(
      "1 configured",
    );
  });

  test("check fields are disabled while session is running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetailWithRunning(page, mockTauri);

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // Expand the check entry
    const checkEntry = checksDetails.locator("details.check-entry").first();
    await checkEntry.locator("summary").click();

    // All fields should be disabled
    const nameInput = checkEntry.getByRole("textbox", { name: /name/i });
    await expect(nameInput).toBeDisabled();

    const commandInput = checkEntry.getByRole("textbox", { name: /command/i });
    await expect(commandInput).toBeDisabled();

    const whenSelect = checkEntry.locator("select");
    await expect(whenSelect).toBeDisabled();

    const timeoutInput = checkEntry.getByRole("spinbutton", {
      name: /timeout/i,
    });
    await expect(timeoutInput).toBeDisabled();

    const retriesInput = checkEntry.getByRole("spinbutton", {
      name: /retries/i,
    });
    await expect(retriesInput).toBeDisabled();
  });

  test("add check button is disabled while session is running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetailWithRunning(page, mockTauri);

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // The "Add Check" button should be disabled
    await expect(
      checksDetails.getByRole("button", { name: "Add Check" }),
    ).toBeDisabled();
  });

  test("remove button is disabled while session is running", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRepoDetailWithRunning(page, mockTauri);

    // Expand checks section
    const checksDetails = page.locator("details.checks");
    await checksDetails.locator("summary").click();

    // The remove button on the check should be disabled
    const checkEntry = checksDetails.locator("details.check-entry").first();
    await expect(
      checkEntry.getByRole("button", { name: "\u00d7" }),
    ).toBeDisabled();
  });
});
