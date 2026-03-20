import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { Badge } from "@/components/ui/badge";
import { sortTraces, type SortField, type SortDir } from "../sort";
import type { SessionTrace } from "../types";
import type { RepoConfig } from "../repos";
import { History } from "lucide-react";

function repoNameFromTrace(
  trace: SessionTrace,
  repoId: string | undefined,
  repos: RepoConfig[],
): string {
  if (repoId) {
    const repo = repos.find((r) => r.id === repoId);
    return repo?.name ?? repoId;
  }
  const normalized = trace.repo_path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
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
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  let name = parts[parts.length - 1] || path;
  name = name.replace(/\.[^.]+$/, "");
  name = name.replace(/^\d{4}-\d{2}-\d{2}[-_]/, "");
  name = name.replace(/[_-]/g, " ");
  return name;
}

function traceRepoId(trace: SessionTrace, repoId: string | undefined): string {
  if (repoId) return repoId;
  return trace.repo_id ?? "unknown";
}

function traceDescription(trace: SessionTrace): {
  text: string;
  tooltip: string;
} {
  if (trace.session_type === "one_shot") {
    if (trace.title) {
      return { text: trace.title, tooltip: trace.prompt };
    }
    return { text: trace.prompt, tooltip: trace.prompt };
  }
  if (trace.plan_file) {
    return { text: planFilename(trace.plan_file), tooltip: trace.plan_file };
  }
  return { text: trace.prompt, tooltip: trace.prompt };
}

type Props = {
  traces: SessionTrace[];
  loading: boolean;
  error: string | null;
  showRepo?: boolean;
  showType?: boolean;
  repos: RepoConfig[];
  repoId?: string;
};

function gridTemplate(showRepo: boolean, showType: boolean): string {
  //       Date     [Type]   [Repo]    Description  Status  Duration
  if (showRepo && showType)
    return "140px 88px minmax(80px, 1fr) minmax(120px, 3fr) 96px 76px";
  if (showType) return "140px 88px minmax(120px, 3fr) 96px 76px";
  if (showRepo) return "140px minmax(80px, 1fr) minmax(120px, 3fr) 96px 76px";
  return "140px minmax(120px, 3fr) 96px 76px";
}

export default function HistoryTable({
  traces,
  loading,
  error,
  showRepo = false,
  showType = true,
  repos,
  repoId,
}: Props) {
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<SortField>("start_time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sortedTraces = useMemo(
    () => sortTraces(traces, sortField, sortDir),
    [traces, sortField, sortDir],
  );

  const colTemplate = gridTemplate(showRepo, showType);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "start_time" ? "desc" : "asc");
    }
  }

  function sortArrow(field: SortField): string | null {
    if (sortField !== field) return null;
    return sortDir === "desc" ? "\u2193" : "\u2191";
  }

  function renderSortButton(
    label: string,
    field: SortField,
    align: "left" | "right" | "center" = "left",
  ) {
    const arrow = sortArrow(field);
    const alignClass =
      align === "right"
        ? "justify-end"
        : align === "center"
          ? "justify-center"
          : "justify-start";
    return (
      <button
        className={`flex items-center gap-1 bg-transparent border-none text-muted-foreground font-mono text-xs font-semibold uppercase tracking-wide cursor-pointer p-0 hover:text-foreground transition-colors duration-150 ${alignClass}`}
        onClick={() => toggleSort(field)}
      >
        <span>{label}</span>
        {arrow && <span className="text-primary-light">{arrow}</span>}
      </button>
    );
  }

  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-12">
        <p>Loading...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <pre className="bg-destructive/10 text-destructive p-3 rounded overflow-x-auto">
          {error}
        </pre>
      </div>
    );
  }

  if (traces.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 rounded-md border border-dashed border-border text-center">
        <History className="size-8 text-muted-foreground mb-3" />
        <p className="text-sm font-medium">No runs recorded yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Completed sessions will appear here
        </p>
      </div>
    );
  }

  return (
    <div className="trace-list flex flex-col gap-1 overflow-x-auto">
      {/* Column headers */}
      <div
        className="trace-header grid items-center gap-x-4 px-3 py-2"
        style={{ gridTemplateColumns: colTemplate }}
      >
        {renderSortButton("Date", "start_time")}
        {showType && renderSortButton("Type", "session_type")}
        {showRepo && (
          <span className="text-muted-foreground font-mono text-xs font-semibold uppercase tracking-wide">
            Repo
          </span>
        )}
        {renderSortButton("Description", "prompt")}
        {renderSortButton("Status", "outcome", "center")}
        {renderSortButton("Duration", "duration", "right")}
      </div>

      {/* Trace rows */}
      {sortedTraces.map((trace) => {
        const badge = outcomeBadge(trace.outcome);
        const name = repoNameFromTrace(trace, repoId, repos);
        const desc = traceDescription(trace);
        return (
          <button
            key={trace.session_id}
            className="trace-row grid items-center gap-x-4 px-3 py-2.5 bg-card border border-border rounded-md cursor-pointer text-foreground text-sm text-left w-full hover:border-primary/30 transition-colors duration-150"
            style={{ gridTemplateColumns: colTemplate }}
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
            <span className="text-muted-foreground text-xs tabular-nums">
              {formatDate(trace.start_time)}
            </span>
            {showType && (
              <span className="text-muted-foreground">
                <Badge variant="outline" className="text-xs font-normal">
                  {trace.session_type === "one_shot" ? "1-Shot" : "Ralph Loop"}
                </Badge>
              </span>
            )}
            {showRepo && (
              <span
                className="truncate text-foreground font-medium"
                title={trace.repo_path}
              >
                {name}
              </span>
            )}
            <span
              className="trace-prompt truncate text-muted-foreground"
              title={desc.tooltip}
            >
              {desc.text}
            </span>
            <span className="trace-badge flex justify-center">
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </span>
            <span className="text-right text-muted-foreground tabular-nums font-mono text-xs">
              {formatDuration(trace.start_time, trace.end_time)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
