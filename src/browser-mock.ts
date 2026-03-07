/**
 * Browser-mode Tauri mock.
 *
 * When the app runs outside Tauri (plain browser), this provides stub
 * implementations of the IPC layer so the UI renders without errors.
 * Import this at the top of main.ts — it's a no-op inside Tauri.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri injects this global at runtime
if (!(window as any).__TAURI_INTERNALS__) {
  // -- Sample data for browser dev mode --

  const SAMPLE_REPOS = [
    {
      id: "repo-alpha",
      name: "my-project",
      path: "/home/user/repos/my-project",
      model: "opus",
      maxIterations: 40,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    },
    {
      id: "repo-beta",
      name: "api-service",
      path: "/home/user/repos/api-service",
      model: "sonnet",
      maxIterations: 10,
      completionSignal: "ALL TODO ITEMS COMPLETE",
    },
  ];

  const SAMPLE_TRACES = [
    {
      session_id: "sess-abc-123",
      repo_path: "/home/user/repos/my-project",
      repo_id: "repo-alpha",
      prompt: "Fix login bug and add tests",
      plan_file: "plans/fix-login.md",
      start_time: "2026-03-07T08:30:00Z",
      end_time: "2026-03-07T08:42:15Z",
      outcome: "completed",
      total_iterations: 3,
      total_cost_usd: 0.4521,
      total_input_tokens: 45200,
      total_output_tokens: 12350,
      total_cache_read_tokens: 8200,
      total_cache_creation_tokens: 3100,
    },
    {
      session_id: "sess-def-456",
      repo_path: "/home/user/repos/my-project",
      repo_id: "repo-alpha",
      prompt: "Refactor auth module to use JWT",
      plan_file: "plans/refactor-auth.md",
      start_time: "2026-03-06T14:10:00Z",
      end_time: "2026-03-06T14:25:30Z",
      outcome: "failed",
      total_iterations: 5,
      total_cost_usd: 0.8912,
      total_input_tokens: 89000,
      total_output_tokens: 24000,
      total_cache_read_tokens: 12000,
      total_cache_creation_tokens: 5000,
    },
    {
      session_id: "sess-ghi-789",
      repo_path: "/home/user/repos/api-service",
      repo_id: "repo-beta",
      prompt: "Add pagination to list endpoints",
      plan_file: null,
      start_time: "2026-03-05T10:00:00Z",
      end_time: "2026-03-05T10:18:45Z",
      outcome: "max_iterations_reached",
      total_iterations: 10,
      total_cost_usd: 1.234,
      total_input_tokens: 120000,
      total_output_tokens: 35000,
      total_cache_read_tokens: 20000,
      total_cache_creation_tokens: 8000,
    },
  ];

  const SAMPLE_EVENTS: Record<string, unknown[]> = {
    "sess-abc-123": [
      {
        kind: "session_started",
        session_id: "sess-abc-123",
        _ts: 1741336200000,
      },
      { kind: "iteration_started", iteration: 1, _ts: 1741336201000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Analyzing the login module to understand the bug...",
        _ts: 1741336205000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741336210000 },
      { kind: "tool_use", iteration: 1, tool_name: "Grep", _ts: 1741336215000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Found the issue - session token validation is missing a null check",
        _ts: 1741336220000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Edit", _ts: 1741336225000 },
      {
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.1523 },
        _ts: 1741336230000,
      },
      { kind: "iteration_started", iteration: 2, _ts: 1741336231000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Now adding unit tests for the login flow...",
        _ts: 1741336235000,
      },
      {
        kind: "tool_use",
        iteration: 2,
        tool_name: "Write",
        _ts: 1741336240000,
      },
      { kind: "tool_use", iteration: 2, tool_name: "Bash", _ts: 1741336250000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Tests pass. Adding integration test coverage.",
        _ts: 1741336255000,
      },
      {
        kind: "iteration_complete",
        iteration: 2,
        result: { total_cost_usd: 0.1612 },
        _ts: 1741336260000,
      },
      { kind: "iteration_started", iteration: 3, _ts: 1741336261000 },
      {
        kind: "assistant_text",
        iteration: 3,
        text: "Running full test suite to verify no regressions...",
        _ts: 1741336265000,
      },
      { kind: "tool_use", iteration: 3, tool_name: "Bash", _ts: 1741336270000 },
      {
        kind: "assistant_text",
        iteration: 3,
        text: "All 47 tests pass. Login bug is fixed and covered by tests.",
        _ts: 1741336275000,
      },
      {
        kind: "iteration_complete",
        iteration: 3,
        result: { total_cost_usd: 0.1386 },
        _ts: 1741336280000,
      },
      { kind: "session_complete", outcome: "completed", _ts: 1741336335000 },
    ],
    "sess-def-456": [
      {
        kind: "session_started",
        session_id: "sess-def-456",
        _ts: 1741268400000,
      },
      { kind: "iteration_started", iteration: 1, _ts: 1741268401000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Reading the auth module to plan the JWT refactor...",
        _ts: 1741268405000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741268410000 },
      { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741268415000 },
      {
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.12 },
        _ts: 1741268430000,
      },
      { kind: "iteration_started", iteration: 2, _ts: 1741268431000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Replacing session-based auth with JWT tokens...",
        _ts: 1741268435000,
      },
      { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741268440000 },
      { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741268450000 },
      {
        kind: "iteration_complete",
        iteration: 2,
        result: { total_cost_usd: 0.18 },
        _ts: 1741268460000,
      },
      { kind: "iteration_started", iteration: 3, _ts: 1741268461000 },
      { kind: "tool_use", iteration: 3, tool_name: "Bash", _ts: 1741268465000 },
      {
        kind: "assistant_text",
        iteration: 3,
        text: "Tests failing - 12 errors related to middleware changes",
        _ts: 1741268475000,
      },
      {
        kind: "iteration_complete",
        iteration: 3,
        result: { total_cost_usd: 0.2 },
        _ts: 1741268480000,
      },
      { kind: "iteration_started", iteration: 4, _ts: 1741268481000 },
      { kind: "tool_use", iteration: 4, tool_name: "Edit", _ts: 1741268490000 },
      { kind: "tool_use", iteration: 4, tool_name: "Bash", _ts: 1741268500000 },
      {
        kind: "assistant_text",
        iteration: 4,
        text: "Still 4 failing tests in the refresh token flow",
        _ts: 1741268510000,
      },
      {
        kind: "iteration_complete",
        iteration: 4,
        result: { total_cost_usd: 0.195 },
        _ts: 1741268520000,
      },
      { kind: "iteration_started", iteration: 5, _ts: 1741268521000 },
      { kind: "tool_use", iteration: 5, tool_name: "Edit", _ts: 1741268530000 },
      { kind: "tool_use", iteration: 5, tool_name: "Bash", _ts: 1741268540000 },
      {
        kind: "assistant_text",
        iteration: 5,
        text: "Build error: circular dependency between auth and middleware",
        _ts: 1741268550000,
      },
      { kind: "session_complete", outcome: "failed", _ts: 1741268730000 },
    ],
    "sess-ghi-789": [
      {
        kind: "session_started",
        session_id: "sess-ghi-789",
        _ts: 1741168800000,
      },
      { kind: "iteration_started", iteration: 1, _ts: 1741168801000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Reading the API routes to understand the list endpoints...",
        _ts: 1741168805000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Grep", _ts: 1741168810000 },
      {
        kind: "iteration_complete",
        iteration: 1,
        result: { total_cost_usd: 0.095 },
        _ts: 1741168830000,
      },
      { kind: "iteration_started", iteration: 2, _ts: 1741168831000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Adding cursor-based pagination to /users endpoint...",
        _ts: 1741168835000,
      },
      { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741168840000 },
      {
        kind: "iteration_complete",
        iteration: 2,
        result: { total_cost_usd: 0.12 },
        _ts: 1741168860000,
      },
      {
        kind: "session_complete",
        outcome: "max_iterations_reached",
        _ts: 1741169925000,
      },
    ],
  };

  // -- Mock infrastructure --

  const store = new Map<string, unknown>([
    ["repos", SAMPLE_REPOS],
    [
      "recents",
      { promptFiles: ["plans/fix-login.md", "plans/refactor-auth.md"] },
    ],
  ]);
  type Callback = (...args: unknown[]) => void;
  const callbacks = new Map<number, Callback>();

  function registerCallback(cb: Callback): number {
    const id = Math.floor(Math.random() * 2 ** 32);
    callbacks.set(id, cb);
    return id;
  }

  async function invoke(cmd: string, args: Record<string, unknown> = {}) {
    // Store plugin
    if (cmd === "plugin:store|load") return 1;
    if (cmd === "plugin:store|get") {
      const key = args.key as string;
      return [store.get(key) ?? null, store.has(key)];
    }
    if (cmd === "plugin:store|set") {
      store.set(args.key as string, args.value);
      return;
    }
    if (cmd === "plugin:store|save") return;
    if (cmd === "plugin:store|has") return store.has(args.key as string);
    if (cmd === "plugin:store|keys") return [...store.keys()];
    if (cmd === "plugin:store|delete") {
      store.delete(args.key as string);
      return true;
    }
    if (cmd === "plugin:store|clear") {
      store.clear();
      return;
    }

    // Dialog plugin
    if (cmd === "plugin:dialog|open") return null;

    // Event plugin
    if (cmd === "plugin:event|listen") return args.handler;
    if (cmd === "plugin:event|unlisten") return;
    if (cmd === "plugin:event|emit") return;

    // App commands
    if (cmd === "list_traces") {
      const repoId = args.repoId as string | null;
      if (repoId) return SAMPLE_TRACES.filter((t) => t.repo_id === repoId);
      return SAMPLE_TRACES;
    }
    if (cmd === "get_trace") {
      const sid = args.sessionId as string;
      return SAMPLE_TRACES.find((t) => t.session_id === sid) ?? null;
    }
    if (cmd === "get_trace_events") {
      const sid = args.sessionId as string;
      return SAMPLE_EVENTS[sid] ?? [];
    }
    if (cmd === "read_file_preview") return "# Sample Plan\n\nThis is a stub preview for browser dev mode.\n\n## Steps\n";
    if (cmd === "stop_session") return;

    console.warn(`[browser-mock] unhandled invoke: ${cmd}`, args);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
  (window as any).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: registerCallback,
    unregisterCallback: (id: number) => callbacks.delete(id),
    runCallback: (id: number, data: unknown) => callbacks.get(id)?.(data),
    callbacks,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    plugins: {
      path: { sep: "/", delimiter: ":" },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global mock
  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => callbacks.delete(id),
  };

  console.info("[browser-mock] Tauri IPC mocks active (browser mode)");
}
