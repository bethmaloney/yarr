import { vi, describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { RepoCard, type GitStatusInfo } from "./RepoCard";
import type { RepoConfig } from "../repos";
import type { SessionTrace, RepoStatus, RepoGitStatus } from "../types";
import type { PlanProgress } from "../plan-progress";

afterEach(() => {
  cleanup();
});

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
    plan_content: null,
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

function makeGitStatus(overrides: Partial<RepoGitStatus> = {}): RepoGitStatus {
  return {
    branchName: "main",
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

function makeGitStatusInfo(
  overrides: Partial<GitStatusInfo> = {},
): GitStatusInfo {
  return {
    status: makeGitStatus(),
    lastChecked: new Date(),
    loading: false,
    error: null,
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
  // 4. Git status — branch name
  // =========================================================================

  it("shows branch name from gitStatus.status.branchName", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ branchName: "feat/cool-feature" }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("feat/cool-feature")).toBeInTheDocument();
  });

  it("does not show branch name when gitStatus is undefined", () => {
    render(<RepoCard repo={makeLocalRepo()} status="idle" onClick={vi.fn()} />);
    // No branch text should be present — query should return null
    expect(screen.queryByText(/feat\//)).not.toBeInTheDocument();
  });

  it("does not show branch name when gitStatus.status is null", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({ status: null })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/main/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 4b. Git status — dirty count
  // =========================================================================

  it("shows dirty count when dirtyCount > 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ dirtyCount: 3 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 dirty/)).toBeInTheDocument();
  });

  it("does not show dirty indicator when dirtyCount is 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ dirtyCount: 0 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/dirty/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 4c. Git status — ahead count
  // =========================================================================

  it("shows ahead count when ahead > 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ ahead: 2 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/2↑/)).toBeInTheDocument();
  });

  it("does not show ahead indicator when ahead is 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ ahead: 0 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
  });

  it("does not show ahead indicator when ahead is null", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ ahead: null }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 4d. Git status — behind count
  // =========================================================================

  it("shows behind count when behind > 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ behind: 1 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/1↓/)).toBeInTheDocument();
  });

  it("shows behind count with yellow/warning text color", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ behind: 1 }),
        })}
        onClick={vi.fn()}
      />,
    );
    const behindEl = screen.getByText(/1↓/);
    expect(behindEl.classList.contains("text-yellow-500")).toBe(true);
  });

  it("does not show behind indicator when behind is 0", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ behind: 0 }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument();
  });

  it("does not show behind indicator when behind is null", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({ behind: null }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 4e. Git status — no indicators when all zero
  // =========================================================================

  it("shows only branch name with no indicators when all counts are zero", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({
            branchName: "main",
            dirtyCount: 0,
            ahead: 0,
            behind: 0,
          }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.queryByText(/dirty/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument();
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument();
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  // =========================================================================
  // 4f. Git status — multiple indicators with separator
  // =========================================================================

  it("shows all non-zero indicators separated by ' · '", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          status: makeGitStatus({
            branchName: "feat/multi",
            dirtyCount: 3,
            ahead: 2,
            behind: 1,
          }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("feat/multi")).toBeInTheDocument();
    expect(screen.getByText(/3 dirty/)).toBeInTheDocument();
    expect(screen.getByText(/2↑/)).toBeInTheDocument();
    expect(screen.getByText(/1↓/)).toBeInTheDocument();
  });

  // =========================================================================
  // 4g. Git status — loading state
  // =========================================================================

  it("shows loading indicator when loading is true", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          loading: true,
          status: null,
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  // =========================================================================
  // 4h. Git status — error state
  // =========================================================================

  it("shows warning icon when error is truthy", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          error: "Failed to fetch git status",
          status: null,
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("⚠")).toBeInTheDocument();
  });

  // =========================================================================
  // 4i. Git status — last checked for non-auto-fetch repos
  // =========================================================================

  it("shows 'last checked' text for SSH repos without autoFetch", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    render(
      <RepoCard
        repo={makeSshRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          lastChecked: fiveMinAgo,
          status: makeGitStatus({ branchName: "main" }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText(/last checked/i)).toBeInTheDocument();
  });

  it("does not show 'last checked' for local repos (auto-fetch enabled by default)", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="idle"
        gitStatus={makeGitStatusInfo({
          lastChecked: new Date(),
          status: makeGitStatus({ branchName: "main" }),
        })}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/last checked/i)).not.toBeInTheDocument();
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

  it("uses max_context_percent when available", () => {
    const trace = makeTrace({
      max_context_percent: 65,
      context_window: 200000,
      final_context_tokens: 100000, // would compute to 50%, but max_context_percent wins
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("65%")).toBeInTheDocument();
  });

  it("falls back to old computation when max_context_percent is missing", () => {
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

  it("falls back to old computation when max_context_percent is 0", () => {
    const trace = makeTrace({
      max_context_percent: 0,
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

  it("prefers max_context_percent over computed value even when both are present", () => {
    const trace = makeTrace({
      max_context_percent: 73,
      context_window: 200000,
      final_context_tokens: 100000, // would compute to 50%
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("73%")).toBeInTheDocument();
  });

  it("shows no context percentage when neither path has data", () => {
    const trace = makeTrace({
      // no max_context_percent, no context_window
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
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

  // =========================================================================
  // 14. Plan excerpt
  // =========================================================================

  it("shows plan excerpt text when planExcerpt is provided with a plan_file trace", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt="This is the excerpt text."
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("This is the excerpt text.")).toBeInTheDocument();
  });

  it("does not show excerpt span when planExcerpt is undefined", () => {
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
    // Only the plan filename should be present, no excerpt
    expect(screen.getByText("deploy-fix.md")).toBeInTheDocument();
    // The excerpt span has exactly this className (no font-mono, no min-w-0, etc.)
    const allSpans = document.querySelectorAll("span");
    const excerptSpans = Array.from(allSpans).filter(
      (span) => span.className === "text-xs text-muted-foreground truncate",
    );
    expect(excerptSpans.length).toBe(0);
  });

  it("does not show excerpt span when planExcerpt is an empty string", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt=""
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("deploy-fix.md")).toBeInTheDocument();
    // The excerpt span has exactly this className (no font-mono, no min-w-0, etc.)
    const allSpans = document.querySelectorAll("span");
    const excerptSpans = Array.from(allSpans).filter(
      (span) => span.className === "text-xs text-muted-foreground truncate",
    );
    expect(excerptSpans.length).toBe(0);
  });

  it("renders a truncated element with long excerpt text", () => {
    const longText =
      "This is a very long excerpt that should be truncated by CSS. "
        .repeat(5)
        .trim();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt={longText}
        onClick={vi.fn()}
      />,
    );
    const excerptEl = screen.getByText(longText);
    expect(excerptEl).toBeInTheDocument();
    expect(excerptEl.classList.contains("truncate")).toBe(true);
  });

  // =========================================================================
  // 15. Plan click behavior
  // =========================================================================

  it("calls onPlanClick (not onClick) when plan filename is clicked", () => {
    const handleClick = vi.fn();
    const handlePlanClick = vi.fn();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={handleClick}
        onPlanClick={handlePlanClick}
      />,
    );
    const planFilename = screen.getByRole("button", { name: "deploy-fix.md" });
    fireEvent.click(planFilename);
    expect(handlePlanClick).toHaveBeenCalledTimes(1);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("calls onPlanClick (not onClick) when plan excerpt is clicked", () => {
    const handleClick = vi.fn();
    const handlePlanClick = vi.fn();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt="This is the excerpt text."
        onClick={handleClick}
        onPlanClick={handlePlanClick}
      />,
    );
    const excerptEl = screen.getByRole("button", {
      name: "This is the excerpt text.",
    });
    fireEvent.click(excerptEl);
    expect(handlePlanClick).toHaveBeenCalledTimes(1);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("plan filename has cursor-pointer class when onPlanClick is provided", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={vi.fn()}
        onPlanClick={vi.fn()}
      />,
    );
    const planFilename = screen.getByRole("button", { name: "deploy-fix.md" });
    expect(planFilename.classList.contains("cursor-pointer")).toBe(true);
  });

  it("plan excerpt has cursor-pointer class when onPlanClick is provided", () => {
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt="Excerpt for cursor check."
        onClick={vi.fn()}
        onPlanClick={vi.fn()}
      />,
    );
    const excerptEl = screen.getByRole("button", {
      name: "Excerpt for cursor check.",
    });
    expect(excerptEl.classList.contains("cursor-pointer")).toBe(true);
  });

  it("plan filename is NOT clickable when onPlanClick is not provided", () => {
    const handleClick = vi.fn();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={handleClick}
      />,
    );
    // Should render as plain text, not as a role="button" element
    expect(
      screen.queryByRole("button", { name: "deploy-fix.md" }),
    ).not.toBeInTheDocument();
    // Click on the plan filename text — should bubble up to card onClick
    const planText = screen.getByText("deploy-fix.md");
    fireEvent.click(planText);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("plan excerpt is NOT clickable when onPlanClick is not provided", () => {
    const handleClick = vi.fn();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        planExcerpt="Plain excerpt text."
        onClick={handleClick}
      />,
    );
    // Should render as plain text, not as a role="button" element
    expect(
      screen.queryByRole("button", { name: "Plain excerpt text." }),
    ).not.toBeInTheDocument();
    // Click on the excerpt text — should bubble up to card onClick
    const excerptText = screen.getByText("Plain excerpt text.");
    fireEvent.click(excerptText);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("clicking card area still calls onClick when onPlanClick is provided", () => {
    const handleClick = vi.fn();
    const handlePlanClick = vi.fn();
    const trace = makeTrace({
      plan_file: "/home/beth/plans/deploy-fix.md",
      plan_content: "some plan content",
    });
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="completed"
        lastTrace={trace}
        onClick={handleClick}
        onPlanClick={handlePlanClick}
      />,
    );
    // Click the card button itself (the outer button with aria-label)
    const cardButton = screen.getByRole("button", {
      name: "my-project — COMPLETED",
    });
    fireEvent.click(cardButton);
    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(handlePlanClick).not.toHaveBeenCalled();
  });

  // =========================================================================
  // 16. Plan progress bar
  // =========================================================================

  it("does not render progress bar when planProgress is undefined", () => {
    render(
      <RepoCard repo={makeLocalRepo()} status="running" onClick={vi.fn()} />,
    );
    // No fraction label like "X/Y" should be present
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  it("does not render progress bar when planProgress is null", () => {
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="running"
        planProgress={null}
        onClick={vi.fn()}
      />,
    );
    expect(screen.queryByText(/^\d+\/\d+$/)).not.toBeInTheDocument();
  });

  it("renders progress bar with fraction when planProgress is provided", () => {
    const progress: PlanProgress = {
      tasks: [],
      totalItems: 42,
      completedItems: 14,
      currentTask: null,
    };
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="running"
        planProgress={progress}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByText("14/42")).toBeInTheDocument();
  });

  it("progress fill uses teal color when incomplete", () => {
    const progress: PlanProgress = {
      tasks: [],
      totalItems: 42,
      completedItems: 14,
      currentTask: null,
    };
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="running"
        planProgress={progress}
        onClick={vi.fn()}
      />,
    );
    const fill = screen.getByTestId("repo-progress-fill");
    expect(fill.classList.contains("bg-[#4ecdc4]")).toBe(true);
  });

  it("progress fill uses green color when all complete", () => {
    const progress: PlanProgress = {
      tasks: [],
      totalItems: 42,
      completedItems: 42,
      currentTask: null,
    };
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="running"
        planProgress={progress}
        onClick={vi.fn()}
      />,
    );
    const fill = screen.getByTestId("repo-progress-fill");
    expect(fill.classList.contains("bg-[#34d399]")).toBe(true);
  });

  it("progress fill width is percentage-based", () => {
    const progress: PlanProgress = {
      tasks: [],
      totalItems: 42,
      completedItems: 21,
      currentTask: null,
    };
    render(
      <RepoCard
        repo={makeLocalRepo()}
        status="running"
        planProgress={progress}
        onClick={vi.fn()}
      />,
    );
    const fill = screen.getByTestId("repo-progress-fill");
    expect(fill.style.width).toBe("50%");
  });
});
