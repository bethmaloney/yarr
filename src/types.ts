import type { PlanProgress } from "./plan-progress";

export type Check = {
  name: string;
  command: string;
  when: "each_iteration" | "post_completion";
  prompt?: string;
  model?: string;
  timeoutSecs: number;
  maxRetries: number;
};

export type GitSyncConfig = {
  enabled: boolean;
  conflictPrompt?: string;
  model?: string;
  maxPushRetries: number;
};

export type RepoGitStatus = {
  branchName: string;
  dirtyCount: number;
  ahead: number | null;
  behind: number | null;
};

export type SessionEvent = {
  kind: string;
  session_id?: string;
  iteration?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  text?: string;
  result?: Record<string, unknown>;
  outcome?: string;
  check_name?: string;
  output?: string;
  attempt?: number;
  success?: boolean;
  title?: string;
  merge_strategy?: string;
  worktree_path?: string;
  branch?: string;
  plan_file?: string;
  strategy?: string;
  reason?: string;
  files?: string[];
  error?: string;
  status?: string;
  tool_output?: string;
  tool_use_id?: string;
  rate_limit_type?: string;
  plan_content?: string;
  _ts?: number;
};

export type SessionTrace = {
  session_id: string;
  repo_path: string;
  prompt: string;
  title?: string | null;
  plan_file: string | null;
  plan_content?: string | null;
  repo_id?: string | null;
  session_type?: string;
  start_time: string;
  end_time: string | null;
  outcome: string;
  failure_reason: string | null;
  total_iterations: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_creation_tokens: number;
  context_window?: number;
  final_context_tokens?: number;
  max_context_percent?: number;
};

export type SessionState = {
  running: boolean;
  session_id?: string;
  disconnected?: boolean;
  reconnecting?: boolean;
  disconnectReason?: string;
  events: SessionEvent[];
  trace: SessionTrace | null;
  error: string | null;
  planProgress?: PlanProgress | null;
};

export type RepoStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "disconnected";

export type TaggedSessionEvent = {
  repo_id: string;
  event: SessionEvent;
};

export type OneShotEntry = {
  id: string; // oneshot-<short_id>
  parentRepoId: string;
  parentRepoName: string;
  title: string;
  prompt: string;
  model: string;
  effortLevel: string;
  designEffortLevel: string;
  mergeStrategy: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  session_id?: string;
  worktreePath?: string;
  branch?: string;
};
