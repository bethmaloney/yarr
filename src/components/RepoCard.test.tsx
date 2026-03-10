import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { RepoCard } from "./RepoCard";
import type { RepoConfig } from "../repos";
import type { SessionTrace, RepoStatus } from "../types";

afterEach(() => {
  cleanup();
});

// ===========================================================================
// Test helpers
// ===========================================================================

function makeLocalRepo(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    type: "local",
    id: "local-1",
    path: "/home/beth/repos/my-project",
    name: "my-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeSshRepo(overrides: Record<string, unknown> = {}): RepoConfig {
  return {
    type: "ssh",
    id: "ssh-1",
    sshHost: "dev-server",
    remotePath: "/home/beth/repos/remote-project",
    name: "remote-project",
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
    ...overrides,
  } as RepoConfig;
}

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    session_id: "sess-1",
    repo_path: "/home/beth/repos/my-project",
    prompt: "test prompt",
    plan_file: null,
    start_time: new Date().toISOString(),
    end_time: null,
    outcome: "completed",
    failure_reason: null,
    total_iterations: 5,
    total_cost_usd: 1.23,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    ...overrides,
  };
}

// ===========================================================================
// RepoCard
// ===========================================================================

describe("RepoCard", () => {
  // =========================================================================
  // 1. Rendering basics
  // =========================================================================

  it("renders as a button element", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("shows the repo name", () => {
    render(
      <RepoCard
        repo={makeLocalRepo({ name: "awesome-repo" } as Partial<RepoConfig>)}
        status="idle"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("awesome-repo")).toBeInTheDocument();
  });

  // =========================================================================
  // 2. Local repo path
  // =========================================================================

  it("shows repo.path for local repos", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    expect(screen.getByText("/home/beth/repos/my-project")).toBeInTheDocument();
  });

  // =========================================================================
  // 3. SSH repo path
  // =========================================================================

  it("shows sshHost:remotePath for SSH repos", () => {
    render(<RepoCard repo={makeSshRepo()} status="idle" onClick={vi.fn()} />);
    expect(
      screen.getByText("dev-server:/home/beth/repos/remote-project"),
    ).toBeInTheDocument();
  });

  // =========================================================================
  // 4. Branch name
  // =========================================================================

  it("shows branch name when provided", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        branchName="feat/cool-feature"
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("feat/cool-feature")).toBeInTheDocument();
  });

  it("does not show branch name when not provided", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    // No branch text should be present — query should return null
    expect(screen.queryByText(/feat\//)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 5. Status display — each status shows its correct label
  // =========================================================================

  const statuses: { status: RepoStatus; label: string }[] = [
    { status: "idle", label: "IDLE" },
    { status: "running", label: "RUNNING" },
    { status: "completed", label: "COMPLETED" },
    { status: "failed", label: "FAILED" },
    { status: "disconnected", label: "DISCONNECTED" },
  ];

  for (const { status, label } of statuses) {
    it(`shows "${label}" label for ${status} status`, () => {
      render(
        <RepoCard repo={makeLocalRepo()} status={status} onClick={vi.fn()} />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }

  // =========================================================================
  // 6. Status labels are uppercase
  // =========================================================================

  it("renders status labels in uppercase", () => {
    render(
      <RepoCard repo={makeLocalRepo()} status="running" onClick={vi.fn()} />,
    );
    const label = screen.getByText("RUNNING");
    expect(label).toBeInTheDocument();
  });

  // =========================================================================
  // 7. aria-label
  // =========================================================================

  it('has aria-label in the format "{name} — {StatusLabel}"', () => {
    render(
      <RepoCard
        repo={makeLocalRepo({ name: "my-project" } as Partial<RepoConfig>)}
        status="running"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "my-project — RUNNING",
    });
    expect(button).toBeInTheDocument();
  });

  it("updates aria-label for different statuses", () => {
    render(
      <RepoCard
        repo={makeLocalRepo({ name: "api-service" } as Partial<RepoConfig>)}
        status="failed"
        onClick={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", {
      name: "api-service — FAILED",
    });
    expect(button).toBeInTheDocument();
  });

  // =========================================================================
  // 8. Click handler
  // =========================================================================

  it("calls onClick when the card is clicked", () => {
    const handleClick = vi.fn();
    render(
      <RepoCard repo={makeLocalRepo()} status="idle" onClick={handleClick} />,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick before clicking", () => {
    const handleClick = vi.fn();
    render(
      <RepoCard repo={makeLocalRepo()} status="idle" onClick={handleClick} />,
    );
    expect(handleClick).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 9. Last trace — plan name (filename only)
  // =========================================================================

  it("shows just the filename from plan_file path", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("deploy-fix.md")).toBeInTheDocument();
  });

  it("does not show full plan_file path", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("/home/beth/plans/deploy-fix.md"),
    ).not.toBeInTheDocument();
  });

  // =========================================================================
  // 10. Last trace — cost
  // =========================================================================

  it("shows cost formatted as $X.XX", () => {
    const trace = makeTrace({ total_cost_usd: 1.23 });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("$1.23")).toBeInTheDocument();
  });

  it("shows zero cost as $0.00", () => {
    const trace = makeTrace({ total_cost_usd: 0 });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("shows fractional cost rounded to two decimal places", () => {
    const trace = makeTrace({ total_cost_usd: 0.1 });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("$0.10")).toBeInTheDocument();
  });

  // =========================================================================
  // 11. Last trace — context percentage
  // =========================================================================

  it("shows context percentage when context_window and final_context_tokens are present", () => {
    const trace = makeTrace({
      context_window: 200000,
      final_context_tokens: 100000,
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("shows high context percentage correctly", () => {
    const trace = makeTrace({
      context_window: 200000,
      final_context_tokens: 180000,
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("90%")).toBeInTheDocument();
  });

  // =========================================================================
  // 12. Last trace — time ago
  // =========================================================================

  it("shows time ago for the trace start_time", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const trace = makeTrace({ start_time: twoHoursAgo });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("2h ago")).toBeInTheDocument();
  });

  it("shows 'just now' for very recent traces", () => {
    const trace = makeTrace({ start_time: new Date().toISOString() });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("just now")).toBeInTheDocument();
  });

  // =========================================================================
  // 13. No last trace — last-run info section is not rendered
  // =========================================================================

  it("does not render last-run info when lastTrace is undefined", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    // Cost indicators should not be present
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    // "ago" time markers should not be present
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
    expect(screen.queryByText("just now")).not.toBeInTheDocument();
  });

  it("does not show plan name when lastTrace is undefined", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    expect(screen.queryByText(/\.md$/)).not.toBeInTheDocument();
  });
});
