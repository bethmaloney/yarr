import { test, expect } from "./fixtures";
import type { TauriMockOptions } from "./fixtures";

const REPO_FIXTURE = {
  id: "repo-1",
  path: "/home/user/repos/my-project",
  name: "my-project",
  model: "opus",
  maxIterations: 40,
  completionSignal: "<promise>COMPLETE</promise>",
};

const TRACE = {
  session_id: "sess-sub-agent-ctx",
  repo_path: "/home/user/repos/my-project",
  repo_id: "repo-1",
  prompt: "Research and implement feature",
  plan_file: null,
  start_time: "2026-03-19T10:00:00Z",
  end_time: "2026-03-19T10:15:00Z",
  outcome: "completed",
  failure_reason: null,
  total_iterations: 1,
  total_cost_usd: 0.25,
  total_input_tokens: 80000,
  total_output_tokens: 5000,
  total_cache_read_tokens: 0,
  total_cache_creation_tokens: 0,
};

const EVENTS = [
  {
    kind: "session_started",
    session_id: "sess-sub-agent-ctx",
    _ts: 1710842400000,
  },
  { kind: "iteration_started", iteration: 1, _ts: 1710842401000 },
  {
    kind: "assistant_text",
    iteration: 1,
    text: "Working on the research task...",
    _ts: 1710842405000,
  },
  {
    kind: "context_updated",
    iteration: 1,
    context_tokens: 80000,
    _ts: 1710842406000,
  },
  {
    kind: "tool_use",
    iteration: 1,
    tool_name: "Agent",
    tool_use_id: "tu_agent_1",
    tool_input: { description: "Research task", prompt: "Do research" },
    _ts: 1710842410000,
  },
  {
    kind: "sub_agent_context_updated",
    iteration: 1,
    parent_tool_use_id: "tu_agent_1",
    context_tokens: 45000,
    _ts: 1710842415000,
  },
  {
    kind: "sub_agent_context_updated",
    iteration: 1,
    parent_tool_use_id: "tu_agent_1",
    context_tokens: 60000,
    _ts: 1710842420000,
  },
  {
    kind: "iteration_complete",
    iteration: 1,
    result: {
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 80000,
        output_tokens: 5000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      model_usage: {
        "claude-opus-4-20250514": { contextWindow: 200000 },
      },
      sub_agent_peak_context: 60000,
    },
    _ts: 1710842430000,
  },
  { kind: "session_complete", outcome: "completed", _ts: 1710842440000 },
];

async function navigateToRunDetail(
  page: import("@playwright/test").Page,
  mockTauri: (opts?: TauriMockOptions) => Promise<void>,
) {
  await mockTauri({
    storeData: { repos: [REPO_FIXTURE] },
    invokeHandlers: {
      list_traces: [TRACE],
      get_trace: TRACE,
      get_trace_events: EVENTS,
    },
  });
  await page.goto("/");

  await page.getByRole("button", { name: "History" }).click();
  await expect(page.locator("h1", { hasText: "History" })).toBeVisible();

  await page.locator(".trace-row").first().click();
  await expect(
    page.locator("h1", { hasText: "Research and implement feature" }),
  ).toBeVisible();
}

test.describe("RunDetail — sub-agent context tracking", () => {
  test("iteration header shows sub-agent peak context", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetail(page, mockTauri);

    const iter1Header = page.locator(".iteration-header", {
      hasText: "Iteration 1",
    });
    await expect(iter1Header).toBeVisible();

    await expect(iter1Header.locator(".iteration-stats")).toContainText(
      "sub-agents peak: 60k/200k",
    );
  });

  test("context bar reflects only main agent context", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetail(page, mockTauri);

    const contextBarLabel = page.locator(".context-bar-label").first();
    await expect(contextBarLabel).toContainText("80k / 200k");

    // The context bar label should NOT contain the sub-agent peak value
    await expect(contextBarLabel).not.toContainText("60k");
  });

  test("Agent tool_use detail shows per-agent context", async ({
    page,
    mockTauri,
  }) => {
    await navigateToRunDetail(page, mockTauri);

    // Expand the iteration group
    const iter1Header = page.locator(".iteration-header", {
      hasText: "Iteration 1",
    });
    await iter1Header.click();

    // Find the Agent tool_use event and click it to expand
    const agentEvent = page.locator(".event.tool_use", {
      hasText: "Agent",
    });
    await expect(agentEvent).toBeVisible();
    await agentEvent.locator(".event-btn").click();

    // The agent-detail panel should show context info
    const agentDetail = page.locator(".agent-detail");
    await expect(agentDetail).toBeVisible();
    await expect(agentDetail).toContainText("context:");
    await expect(agentDetail).toContainText("60k / 200k");
  });
});
