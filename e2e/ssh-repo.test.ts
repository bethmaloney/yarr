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
