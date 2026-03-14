import { useState, useEffect, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { sortTraces, type SortField, type SortDir } from "../sort";
import type { SessionTrace } from "../types";
import type { RepoConfig } from "../repos";

function repoNameFromTrace(
  trace: SessionTrace,
  repoId: string | undefined,
  repos: RepoConfig[],
): string {
  if (repoId) {
    const repo = repos.find((r) => r.id === repoId);
    return repo?.name ?? repoId;
  }
  const parts = trace.repo_path.split("/");
  return parts[parts.length - 1] || trace.repo_path;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "\u2014";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function outcomeBadge(outcome: string): {
  label: string;
  variant: "completed" | "failed" | "maxiters" | "cancelled" | "secondary";
} {
  switch (outcome) {
    case "completed":
      return { label: "Completed", variant: "completed" };
    case "failed":
      return { label: "Failed", variant: "failed" };
    case "max_iterations_reached":
      return { label: "Max Iters", variant: "maxiters" };
    case "cancelled":
      return { label: "Cancelled", variant: "cancelled" };
    default:
      return { label: outcome, variant: "secondary" };
  }
}

function planFilename(path: string | null): string {
  if (!path) return "\u2014";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function traceRepoId(trace: SessionTrace, repoId: string | undefined): string {
  if (repoId) return repoId;
  return trace.repo_id ?? "unknown";
}

export default function History() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();
  const repos = useAppStore((s) => s.repos);

  const [traces, setTraces] = useState<SessionTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("start_time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sortedTraces = useMemo(
    () => sortTraces(traces, sortField, sortDir),
    [traces, sortField, sortDir],
  );

  useEffect(() => {
    let cancelled = false;
    invoke<SessionTrace[]>("list_traces", { repoId: repoId ?? null })
      .then((result) => {
        if (!cancelled) {
          setTraces(result);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "start_time" ? "desc" : "asc");
    }
  }

  const repoName = repoId
    ? (repos.find((r) => r.id === repoId)?.name ?? repoId)
    : undefined;

  const breadcrumbs = repoId
    ? [
        { label: "Home", onClick: () => navigate("/") },
        { label: repoName!, onClick: () => navigate("/repo/" + repoId) },
        { label: "History" },
      ]
    : [{ label: "Home", onClick: () => navigate("/") }, { label: "History" }];

  function sortArrow(field: SortField): string | null {
    if (sortField !== field) return null;
    return sortDir === "desc" ? "\u2193" : "\u2191";
  }

  function renderSortButton(
    label: string,
    field: SortField,
    className: string,
  ) {
    const arrow = sortArrow(field);
    return (
      <button
        className={`bg-transparent border-none text-inherit font-inherit cursor-pointer p-0 ${className}`}
        onClick={() => toggleSort(field)}
      >
        <span>{label}</span>
        {arrow && <span> {arrow}</span>}
      </button>
    );
  }

  if (loading) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <h1 className="text-3xl text-primary mb-4">History</h1>
        <div className="text-center text-muted-foreground py-12">
          <p>Loading...</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <h1 className="text-3xl text-primary mb-4">History</h1>
        <div>
          <pre className="bg-destructive/10 text-destructive p-3 rounded overflow-x-auto">
            {error}
          </pre>
        </div>
      </main>
    );
  }

  if (traces.length === 0) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <h1 className="text-3xl text-primary mb-4">History</h1>
        <div className="text-center text-muted-foreground py-12">
          <p>No runs recorded yet.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-[1100px] mx-auto p-8">
      <Breadcrumbs crumbs={breadcrumbs} />
      <h1 className="text-3xl text-primary mb-4">History</h1>

      <div className="trace-list flex flex-col gap-1">
        {/* Column headers */}
        <div className="trace-header flex items-center gap-4 px-3 py-1.5 text-muted-foreground font-mono text-xs font-semibold uppercase tracking-wide">
          {renderSortButton(
            "Date",
            "start_time",
            "text-left flex-shrink-0 min-w-28",
          )}
          {renderSortButton(
            "Type",
            "session_type",
            "text-left flex-shrink-0 min-w-22",
          )}
          {!repoId && (
            <span className="flex-shrink-0 min-w-24 max-w-40 overflow-hidden text-ellipsis whitespace-nowrap">
              Repo
            </span>
          )}
          {renderSortButton(
            "Plan",
            "plan_file",
            "text-left flex-shrink-0 w-32 overflow-hidden text-ellipsis whitespace-nowrap",
          )}
          {renderSortButton(
            "Prompt",
            "prompt",
            "text-left flex-1 min-w-24 overflow-hidden text-ellipsis whitespace-nowrap",
          )}
          {renderSortButton(
            "Status",
            "outcome",
            "text-center flex-shrink-0 min-w-22",
          )}
          {renderSortButton(
            "Iters",
            "total_iterations",
            "text-right flex-shrink-0 min-w-16",
          )}
          {renderSortButton(
            "Cost",
            "total_cost_usd",
            "text-right flex-shrink-0 min-w-16",
          )}
          {renderSortButton(
            "Duration",
            "duration",
            "text-right flex-shrink-0 min-w-16",
          )}
        </div>

        {/* Trace rows */}
        {sortedTraces.map((trace) => {
          const badge = outcomeBadge(trace.outcome);
          return (
            <button
              key={trace.session_id}
              className="trace-row flex items-center gap-4 px-3 py-2.5 bg-card border border-border rounded-md cursor-pointer text-foreground font-mono text-sm text-left w-full hover:bg-accent hover:border-accent"
              onClick={() => {
                if (trace.session_type === "one_shot") {
                  navigate(`/oneshot/${trace.repo_id ?? "unknown"}`);
                } else {
                  navigate(
                    `/run/${traceRepoId(trace, repoId)}/${trace.session_id}`,
                  );
                }
              }}
            >
              <span className="flex-shrink-0 min-w-28 text-muted-foreground">
                {formatDate(trace.start_time)}
              </span>
              <span className="flex-shrink-0 min-w-22 text-muted-foreground">
                {trace.session_type === "one_shot" ? "1-Shot" : "Ralph Loop"}
              </span>
              {!repoId && (
                <span className="flex-shrink-0 min-w-24 max-w-40 overflow-hidden text-ellipsis whitespace-nowrap text-teal-400">
                  {repoNameFromTrace(trace, repoId, repos)}
                </span>
              )}
              <span className="trace-plan flex-shrink-0 w-32 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                {planFilename(trace.plan_file)}
              </span>
              <span className="trace-prompt flex-1 min-w-24 max-w-80 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground">
                {trace.prompt}
              </span>
              <span className="trace-badge flex-shrink-0 min-w-22 text-center">
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </span>
              <span className="flex-shrink-0 min-w-16 text-right text-muted-foreground">
                {trace.total_iterations}
              </span>
              <span className="flex-shrink-0 min-w-16 text-right text-muted-foreground">
                ${trace.total_cost_usd.toFixed(4)}
              </span>
              <span className="flex-shrink-0 min-w-16 text-right text-muted-foreground">
                {formatDuration(trace.start_time, trace.end_time)}
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
