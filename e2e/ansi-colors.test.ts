import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const REPO_FIXTURE = {
  id: "repo-1",
  path: "/home/user/repos/my-project",
  name: "my-project",
  model: "opus",
  maxIterations: 40,
  completionSignal: "ALL TODO ITEMS COMPLETE",
};

const TRACE = {
  session_id: "sess-ansi-001",
  repo_path: "/home/user/repos/my-project",
  repo_id: "repo-1",
  prompt: "Run tests",
  plan_file: null,
  start_time: "2026-03-15T10:00:00Z",
  end_time: "2026-03-15T10:05:00Z",
  outcome: "completed",
  failure_reason: null,
  total_iterations: 1,
  total_cost_usd: 0.12,
  total_input_tokens: 10000,
  total_output_tokens: 2000,
  total_cache_read_tokens: 0,
  total_cache_creation_tokens: 0,
};

function makeEvents(toolOutput: string) {
  return [
    {
      kind: "session_started",
      session_id: "sess-ansi-001",
      _ts: 1741600000000,
    },
    { kind: "iteration_started", iteration: 1, _ts: 1741600001000 },
    {
      kind: "tool_use",
      iteration: 1,
      tool_name: "Bash",
      tool_input: { command: "cargo test" },
      tool_output: toolOutput,
      _ts: 1741600002000,
    },
    {
      kind: "iteration_complete",
      iteration: 1,
      result: { total_cost_usd: 0.12 },
      _ts: 1741600003000,
    },
    { kind: "session_complete", outcome: "completed", _ts: 1741600004000 },
  ];
}

async function navigateToRunDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
  toolOutput: string,
) {
  const events = makeEvents(toolOutput);
  await mockTauri({
    storeData: {
      repos: [REPO_FIXTURE],
    },
    invokeHandlers: {
      list_traces: [TRACE],
      get_trace: TRACE,
      get_trace_events: events,
    },
  });
  await page.goto("/");

  // Home -> History
  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

  // History -> RunDetail
  await page.locator(".trace-row").first().click();
  await expect(page.locator("h1", { hasText: "Run tests" })).toBeVisible();
}

async function expandToolUseEvent(page: import("@playwright/test").Page) {
  // Expand the iteration group first
  const iterHeader = page.locator(".iteration-header").first();
  await iterHeader.click();

  // Then click the tool_use event to expand it
  const toolUseBtn = page.locator(".event.tool_use .event-btn").first();
  await toolUseBtn.click();
}

/** Locate the <pre> inside the ToolOutputSection (the div with the "Output" label). */
function toolOutputPre(page: import("@playwright/test").Page) {
  return page
    .locator(".event.tool_use")
    .first()
    .locator("div", { hasText: "Output" })
    .first()
    .locator("pre");
}

test.describe("ANSI color rendering in tool output", () => {
  test("renders ANSI color codes as spans with correct classes", async ({
    page,
    mockTauri,
  }) => {
    const output = "\x1b[1m\x1b[32mPassed\x1b[0m: all tests ok";
    await navigateToRunDetail(page, mockTauri, output);
    await expandToolUseEvent(page);

    const pre = toolOutputPre(page);
    await expect(pre).toBeVisible();

    // "Passed" should be wrapped in a span with ansi-bold and ansi-fg-green
    const greenBoldSpan = pre.locator("span.ansi-fg-green");
    await expect(greenBoldSpan).toBeVisible();
    await expect(greenBoldSpan).toHaveClass(/ansi-bold/);
    await expect(greenBoldSpan).toHaveText("Passed");
  });

  test("no raw escape characters appear in visible text", async ({
    page,
    mockTauri,
  }) => {
    const output =
      "\x1b[31mError\x1b[0m: something failed\n\x1b[32mOK\x1b[0m: recovered";
    await navigateToRunDetail(page, mockTauri, output);
    await expandToolUseEvent(page);

    const pre = toolOutputPre(page);
    await expect(pre).toBeVisible();

    const textContent = await pre.textContent();
    // Ensure no raw ANSI escape sequences remain in the rendered text
    expect(textContent).not.toContain("\x1b");
    expect(textContent).not.toContain("\u001b");
  });

  test("plain text is not wrapped in ANSI spans", async ({
    page,
    mockTauri,
  }) => {
    const output = "\x1b[32mGreen\x1b[0m plain text here";
    await navigateToRunDetail(page, mockTauri, output);
    await expandToolUseEvent(page);

    const pre = toolOutputPre(page);
    await expect(pre).toBeVisible();

    // "Green" should be in a styled span
    const greenSpan = pre.locator("span.ansi-fg-green");
    await expect(greenSpan).toHaveText("Green");

    // The plain text portions (" plain text here") should NOT be inside
    // spans with ansi-* classes. Verify that no ansi span contains "plain text here".
    const ansiSpans = pre.locator("span[class*='ansi-']");
    const count = await ansiSpans.count();
    for (let i = 0; i < count; i++) {
      const text = await ansiSpans.nth(i).textContent();
      expect(text).not.toContain("plain text here");
    }

    // But the plain text should still be in the pre
    const fullText = await pre.textContent();
    expect(fullText).toContain("plain text here");
  });

  test("ANSI bold renders with ansi-bold class", async ({
    page,
    mockTauri,
  }) => {
    const output = "\x1b[1mBold text\x1b[0m normal text";
    await navigateToRunDetail(page, mockTauri, output);
    await expandToolUseEvent(page);

    const pre = toolOutputPre(page);
    await expect(pre).toBeVisible();

    const boldSpan = pre.locator("span.ansi-bold");
    await expect(boldSpan).toBeVisible();
    await expect(boldSpan).toHaveText("Bold text");
  });

  test("truncation works correctly with ANSI-colored output", async ({
    page,
    mockTauri,
  }) => {
    // Build output with 25 lines, each containing ANSI color codes
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(`\x1b[32mtest ${i}\x1b[0m: passed`);
    }
    const output = lines.join("\n");

    await navigateToRunDetail(page, mockTauri, output);
    await expandToolUseEvent(page);

    const pre = toolOutputPre(page);
    await expect(pre).toBeVisible();

    // Only the first 20 lines should be visible initially
    const initialText = await pre.textContent();
    expect(initialText).toContain("test 20");
    expect(initialText).not.toContain("test 21");

    // "Show more" button should be visible with the remaining line count
    const showMoreBtn = page.getByRole("button", { name: /Show more/ });
    await expect(showMoreBtn).toBeVisible();
    await expect(showMoreBtn).toHaveText(/5 more lines/);

    // Click "Show more"
    await showMoreBtn.click();

    // All 25 lines should now be visible
    const expandedText = await pre.textContent();
    expect(expandedText).toContain("test 25");

    // ANSI spans should still render correctly after expansion
    const greenSpans = pre.locator("span.ansi-fg-green");
    // Each of the 25 lines has a green span for "test N"
    await expect(greenSpans).toHaveCount(25);
  });
});
