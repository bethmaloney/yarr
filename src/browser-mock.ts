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

  const SAMPLE_ONESHOT_ENTRIES: [string, {
    id: string;
    parentRepoId: string;
    parentRepoName: string;
    title: string;
    prompt: string;
    model: string;
    mergeStrategy: string;
    status: "running" | "completed" | "failed";
    startedAt: number;
  }][] = [
    [
      "oneshot-abc-001",
      {
        id: "oneshot-abc-001",
        parentRepoId: "repo-alpha",
        parentRepoName: "my-project",
        title: "Add dark mode support",
        prompt: "Add a dark mode toggle to the settings page. Use CSS custom properties for theming and persist the preference in localStorage.",
        model: "opus",
        mergeStrategy: "branch",
        status: "completed",
        startedAt: 1741422600000, // 2026-03-08T10:30:00Z
      },
    ],
    [
      "oneshot-abc-002",
      {
        id: "oneshot-abc-002",
        parentRepoId: "repo-alpha",
        parentRepoName: "my-project",
        title: "Fix CSV export encoding",
        prompt: "The CSV export is producing garbled output for non-ASCII characters. Fix the encoding to use UTF-8 with BOM.",
        model: "sonnet",
        mergeStrategy: "direct",
        status: "running",
        startedAt: 1741509000000, // 2026-03-09T10:30:00Z
      },
    ],
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
    {
      session_id: "oneshot-abc-001",
      repo_path: "/home/user/repos/my-project",
      repo_id: "repo-alpha",
      prompt: "Add a dark mode toggle to the settings page.",
      plan_file: null,
      session_type: "one_shot",
      start_time: "2026-03-08T10:30:00Z",
      end_time: "2026-03-08T10:52:30Z",
      outcome: "completed",
      total_iterations: 4,
      total_cost_usd: 0.6234,
      total_input_tokens: 68000,
      total_output_tokens: 18500,
      total_cache_read_tokens: 12000,
      total_cache_creation_tokens: 4500,
    },
    {
      session_id: "oneshot-abc-002",
      repo_path: "/home/user/repos/my-project",
      repo_id: "repo-alpha",
      prompt: "Fix the CSV export encoding to use UTF-8 with BOM.",
      plan_file: null,
      session_type: "one_shot",
      start_time: "2026-03-09T10:30:00Z",
      end_time: null,
      outcome: "running",
      total_iterations: 2,
      total_cost_usd: 0.2815,
      total_input_tokens: 35000,
      total_output_tokens: 8200,
      total_cache_read_tokens: 6000,
      total_cache_creation_tokens: 2200,
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
        result: {
          total_cost_usd: 0.1523,
          input_tokens: 30000,
          output_tokens: 3200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 2000,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.1612,
          input_tokens: 62000,
          output_tokens: 4500,
          cache_read_input_tokens: 18000,
          cache_creation_input_tokens: 3000,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.1386,
          input_tokens: 95000,
          output_tokens: 5800,
          cache_read_input_tokens: 32000,
          cache_creation_input_tokens: 4000,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.12,
          input_tokens: 28000,
          output_tokens: 2800,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 1800,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.18,
          input_tokens: 55000,
          output_tokens: 5200,
          cache_read_input_tokens: 15000,
          cache_creation_input_tokens: 2500,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.2,
          input_tokens: 85000,
          output_tokens: 7000,
          cache_read_input_tokens: 28000,
          cache_creation_input_tokens: 3500,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.195,
          input_tokens: 115000,
          output_tokens: 8500,
          cache_read_input_tokens: 42000,
          cache_creation_input_tokens: 4200,
          context_window: 200000,
        },
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
      {
        kind: "iteration_complete",
        iteration: 5,
        result: {
          total_cost_usd: 0.1962,
          input_tokens: 140000,
          output_tokens: 9800,
          cache_read_input_tokens: 55000,
          cache_creation_input_tokens: 5000,
          context_window: 200000,
        },
        _ts: 1741268555000,
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
        result: {
          total_cost_usd: 0.095,
          input_tokens: 25000,
          output_tokens: 2500,
          cache_read_input_tokens: 3500,
          cache_creation_input_tokens: 1500,
          context_window: 200000,
        },
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
        result: {
          total_cost_usd: 0.12,
          input_tokens: 52000,
          output_tokens: 4800,
          cache_read_input_tokens: 14000,
          cache_creation_input_tokens: 2800,
          context_window: 200000,
        },
        _ts: 1741168860000,
      },
      {
        kind: "session_complete",
        outcome: "max_iterations_reached",
        _ts: 1741169925000,
      },
    ],
    "oneshot-abc-001": [
      {
        kind: "one_shot_started",
        title: "Add dark mode support",
        merge_strategy: "branch",
        _ts: 1741422600000,
      },
      {
        kind: "design_phase_started",
        _ts: 1741422602000,
      },
      { kind: "iteration_started", iteration: 1, _ts: 1741422603000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Analyzing the current theme setup and planning the dark mode implementation...",
        _ts: 1741422610000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741422615000 },
      { kind: "tool_use", iteration: 1, tool_name: "Grep", _ts: 1741422620000 },
      {
        kind: "iteration_complete",
        iteration: 1,
        result: {
          total_cost_usd: 0.12,
          input_tokens: 22000,
          output_tokens: 3500,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 1500,
          context_window: 200000,
        },
        _ts: 1741422630000,
      },
      {
        kind: "design_phase_complete",
        _ts: 1741422631000,
      },
      {
        kind: "implementation_phase_started",
        _ts: 1741422632000,
      },
      { kind: "iteration_started", iteration: 2, _ts: 1741422633000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Creating CSS custom properties for light and dark themes...",
        _ts: 1741422640000,
      },
      { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741422645000 },
      { kind: "tool_use", iteration: 2, tool_name: "Write", _ts: 1741422650000 },
      {
        kind: "iteration_complete",
        iteration: 2,
        result: {
          total_cost_usd: 0.18,
          input_tokens: 48000,
          output_tokens: 6200,
          cache_read_input_tokens: 12000,
          cache_creation_input_tokens: 2500,
          context_window: 200000,
        },
        _ts: 1741422660000,
      },
      { kind: "iteration_started", iteration: 3, _ts: 1741422661000 },
      {
        kind: "assistant_text",
        iteration: 3,
        text: "Adding the toggle component and localStorage persistence...",
        _ts: 1741422665000,
      },
      { kind: "tool_use", iteration: 3, tool_name: "Write", _ts: 1741422670000 },
      { kind: "tool_use", iteration: 3, tool_name: "Edit", _ts: 1741422675000 },
      { kind: "tool_use", iteration: 3, tool_name: "Bash", _ts: 1741422680000 },
      {
        kind: "assistant_text",
        iteration: 3,
        text: "All tests passing. Dark mode toggle works correctly.",
        _ts: 1741422685000,
      },
      {
        kind: "iteration_complete",
        iteration: 3,
        result: {
          total_cost_usd: 0.19,
          input_tokens: 72000,
          output_tokens: 7800,
          cache_read_input_tokens: 22000,
          cache_creation_input_tokens: 3500,
          context_window: 200000,
        },
        _ts: 1741422690000,
      },
      {
        kind: "implementation_phase_complete",
        _ts: 1741422691000,
      },
      {
        kind: "git_finalize_started",
        _ts: 1741422692000,
      },
      { kind: "iteration_started", iteration: 4, _ts: 1741422693000 },
      {
        kind: "assistant_text",
        iteration: 4,
        text: "Creating branch and committing changes...",
        _ts: 1741422695000,
      },
      { kind: "tool_use", iteration: 4, tool_name: "Bash", _ts: 1741422698000 },
      {
        kind: "iteration_complete",
        iteration: 4,
        result: {
          total_cost_usd: 0.1334,
          input_tokens: 95000,
          output_tokens: 4200,
          cache_read_input_tokens: 35000,
          cache_creation_input_tokens: 4000,
          context_window: 200000,
        },
        _ts: 1741422700000,
      },
      {
        kind: "git_finalize_complete",
        _ts: 1741422701000,
      },
      { kind: "one_shot_complete", _ts: 1741422750000 },
    ],
    "oneshot-abc-002": [
      {
        kind: "one_shot_started",
        title: "Fix CSV export encoding",
        merge_strategy: "direct",
        _ts: 1741509000000,
      },
      {
        kind: "design_phase_started",
        _ts: 1741509002000,
      },
      { kind: "iteration_started", iteration: 1, _ts: 1741509003000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Investigating the CSV export code to find the encoding issue...",
        _ts: 1741509010000,
      },
      { kind: "tool_use", iteration: 1, tool_name: "Grep", _ts: 1741509015000 },
      { kind: "tool_use", iteration: 1, tool_name: "Read", _ts: 1741509020000 },
      {
        kind: "assistant_text",
        iteration: 1,
        text: "Found it — the export uses plain TextEncoder without BOM prefix.",
        _ts: 1741509025000,
      },
      {
        kind: "iteration_complete",
        iteration: 1,
        result: {
          total_cost_usd: 0.1315,
          input_tokens: 18000,
          output_tokens: 3200,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 1200,
          context_window: 200000,
        },
        _ts: 1741509030000,
      },
      {
        kind: "design_phase_complete",
        _ts: 1741509031000,
      },
      {
        kind: "implementation_phase_started",
        _ts: 1741509032000,
      },
      { kind: "iteration_started", iteration: 2, _ts: 1741509033000 },
      {
        kind: "assistant_text",
        iteration: 2,
        text: "Adding UTF-8 BOM to the CSV export output...",
        _ts: 1741509040000,
      },
      { kind: "tool_use", iteration: 2, tool_name: "Edit", _ts: 1741509045000 },
      {
        kind: "iteration_complete",
        iteration: 2,
        result: {
          total_cost_usd: 0.15,
          input_tokens: 42000,
          output_tokens: 5000,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 2000,
          context_window: 200000,
        },
        _ts: 1741509050000,
      },
    ],
  };

  // -- Mock infrastructure --

  const store = new Map<string, unknown>([
    ["repos", SAMPLE_REPOS],
    ["oneshot-entries", SAMPLE_ONESHOT_ENTRIES],
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

    // Log plugin
    if (cmd.startsWith("plugin:log|")) return undefined;

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
    if (cmd === "list_latest_traces") {
      const latest = new Map<string, (typeof SAMPLE_TRACES)[0]>();
      for (const t of SAMPLE_TRACES) {
        if (t.repo_id) {
          const existing = latest.get(t.repo_id);
          if (!existing || t.start_time > existing.start_time) {
            latest.set(t.repo_id, t);
          }
        }
      }
      return [...latest.values()];
    }
    if (cmd === "get_branch_info") {
      return { name: "main", ahead: 0, behind: 2 };
    }
    if (cmd === "get_repo_git_status") {
      return { branchName: "main", dirtyCount: 0, ahead: 0, behind: 2 };
    }
    if (cmd === "list_local_branches") {
      return [
        "main",
        "feat/login-flow",
        "feat/dashboard-v2",
        "fix/auth-bug",
        "chore/deps-update",
      ];
    }
    if (cmd === "switch_branch") return;
    if (cmd === "fast_forward_branch") return;
    if (cmd === "read_file_preview")
      return "# Sample Plan\n\nThis is a stub preview for browser dev mode.\n\n## Steps\n";
    if (cmd === "stop_session") return;
    if (cmd === "get_active_sessions") return [];
    if (cmd === "run_oneshot") {
      return { oneshot_id: `oneshot-mock-${Date.now()}` };
    }

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
