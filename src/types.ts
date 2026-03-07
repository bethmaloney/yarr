export type SessionEvent = {
  kind: string;
  session_id?: string;
  iteration?: number;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  text?: string;
  result?: Record<string, unknown>;
  outcome?: string;
  _ts?: number;
};

export type SessionTrace = {
  session_id: string;
  repo_path: string;
  prompt: string;
  plan_file: string | null;
  repo_id?: string | null;
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
};

export type SessionState = {
  running: boolean;
  disconnected?: boolean;
  reconnecting?: boolean;
  events: SessionEvent[];
  trace: SessionTrace | null;
  error: string | null;
};

export type RepoStatus = "idle" | "running" | "completed" | "failed" | "disconnected";

export type TaggedSessionEvent = {
  repo_id: string;
  event: SessionEvent;
};
