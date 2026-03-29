import { X } from "lucide-react";
import { timeAgo } from "../time";
import { sessionContextColor } from "../context-bar";
import type { RepoConfig } from "../repos";
import type { PlanProgress } from "../plan-progress";
import type { RepoGitStatus, RepoStatus, SessionTrace } from "../types";

export interface GitStatusInfo {
  status: RepoGitStatus | null;
  lastChecked: Date | null;
  loading: boolean;
  error: string | null;
}

interface RepoCardProps {
  repo: RepoConfig;
  status: RepoStatus;
  lastTrace?: SessionTrace;
  gitStatus?: GitStatusInfo;
  planExcerpt?: string;
  planProgress?: PlanProgress | null;
  onClick: () => void;
  onPlanClick?: () => void;
  onRemove?: () => void;
}

const statusColors: Record<RepoStatus, string> = {
  idle: "var(--muted-foreground)",
  running: "var(--warning)",
  completed: "var(--success)",
  failed: "var(--destructive)",
  disconnected: "var(--warning)",
};

const statusLabels: Record<RepoStatus, string> = {
  idle: "IDLE",
  running: "RUNNING",
  completed: "COMPLETED",
  failed: "FAILED",
  disconnected: "DISCONNECTED",
};

function shouldShowLastChecked(repo: RepoConfig): boolean {
  return (
    repo.autoFetch === false ||
    (repo.autoFetch === undefined && repo.type === "ssh")
  );
}

export function RepoCard({
  repo,
  status,
  lastTrace,
  gitStatus,
  planExcerpt,
  planProgress,
  onClick,
  onPlanClick,
  onRemove,
}: RepoCardProps) {
  const repoFullPath =
    repo.type === "ssh" ? `${repo.sshHost}:${repo.remotePath}` : repo.path;

  const dotClassName = [
    "w-2 h-2 rounded-full shrink-0",
    status === "running" ? "motion-safe:animate-pulse" : "",
    status === "disconnected" ? "animate-blink" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const gs = gitStatus?.status;
  const indicators: React.ReactNode[] = [];
  if (gs) {
    if (gs.dirtyCount > 0) {
      indicators.push(<span key="dirty">{gs.dirtyCount} dirty</span>);
    }
    if (gs.ahead != null && gs.ahead > 0) {
      indicators.push(<span key="ahead">{gs.ahead}&#x2191;</span>);
    }
    if (gs.behind != null && gs.behind > 0) {
      indicators.push(
        <span key="behind" className="text-warning">
          {gs.behind}&#x2193;
        </span>,
      );
    }
  }

  return (
    <button
      className="group relative flex flex-col gap-1.5 p-4 px-5 bg-card border border-border rounded-md cursor-pointer text-left w-full h-full transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      onClick={onClick}
      aria-label={`${repo.name} \u2014 ${statusLabels[status]}`}
    >
      {onRemove && (
        <div
          role="button"
          tabIndex={0}
          className="absolute top-2 right-2 p-1 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-opacity duration-150"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove repository"
        >
          <X className="size-3.5" />
        </div>
      )}
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-lg font-semibold text-foreground truncate">
          {repo.name}
        </span>
        <span className="text-xs text-muted-foreground font-mono truncate">
          {repoFullPath}
        </span>
        {gitStatus?.loading && !gs && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            Loading...
          </span>
        )}
        {gitStatus?.error && !gs && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            &#x26A0;
          </span>
        )}
        {gs && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            {gs.branchName}
            {indicators.length > 0 && (
              <>
                {" "}
                {indicators.map((ind, i) => (
                  <span key={i}>
                    {i > 0 && <span> &middot; </span>}
                    {ind}
                  </span>
                ))}
              </>
            )}
          </span>
        )}
        {gitStatus && shouldShowLastChecked(repo) && gitStatus.lastChecked && (
          <span className="text-xs text-muted-foreground font-mono truncate">
            last checked: {timeAgo(gitStatus.lastChecked.toISOString())}
          </span>
        )}
      </div>

      {lastTrace?.plan_file &&
        (onPlanClick && lastTrace?.plan_content ? (
          <span
            role="button"
            className="text-xs text-muted-foreground font-mono truncate min-w-0 cursor-pointer hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onPlanClick();
            }}
          >
            {lastTrace.plan_file.split(/[\\/]/).pop()}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground font-mono truncate min-w-0">
            {lastTrace.plan_file.split(/[\\/]/).pop()}
          </span>
        ))}
      {planExcerpt &&
        (onPlanClick && lastTrace?.plan_content ? (
          <span
            role="button"
            className="text-xs text-muted-foreground truncate cursor-pointer hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              onPlanClick();
            }}
          >
            {planExcerpt}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground truncate">
            {planExcerpt}
          </span>
        ))}

      <div className="flex-1" />

      {planProgress &&
        (() => {
          const pct =
            planProgress.totalItems > 0
              ? Math.round(
                  (planProgress.completedItems / planProgress.totalItems) * 100,
                )
              : 0;
          return (
            <div className="flex items-center gap-2 w-full">
              <div className="flex-1 h-[3px] rounded-full bg-card-inset overflow-hidden">
                <div
                  data-testid="repo-progress-fill"
                  className={
                    planProgress.completedItems === planProgress.totalItems
                      ? "bg-success"
                      : "bg-info"
                  }
                  style={{ width: `${pct}%`, height: "100%" }}
                />
              </div>
              <span className="text-xs text-muted-foreground font-mono shrink-0">
                {planProgress.completedItems}/{planProgress.totalItems}
              </span>
            </div>
          );
        })()}

      <div className="flex items-center gap-2 min-w-0">
        <span
          className={dotClassName}
          style={{ background: statusColors[status] }}
          aria-hidden="true"
        />
        <span
          className="text-xs font-medium uppercase tracking-wider"
          style={{ color: statusColors[status] }}
        >
          {statusLabels[status]}
        </span>
        {lastTrace && (
          <div className="flex items-center gap-1 ml-auto text-xs text-muted-foreground shrink-0">
            <span>${(lastTrace.total_cost_usd ?? 0).toFixed(2)}</span>
            {(() => {
              const ctxPct =
                lastTrace.max_context_percent &&
                lastTrace.max_context_percent > 0
                  ? Math.round(lastTrace.max_context_percent)
                  : lastTrace.context_window && lastTrace.context_window > 0
                    ? Math.round(
                        ((lastTrace.final_context_tokens ?? 0) /
                          lastTrace.context_window) *
                          100,
                      )
                    : null;
              if (ctxPct === null) return null;
              return (
                <>
                  <span className="separator"> &middot; </span>
                  <span
                    style={{
                      color: sessionContextColor(ctxPct),
                    }}
                  >
                    {ctxPct}%
                  </span>
                </>
              );
            })()}
            <span className="separator"> &middot; </span>
            <span>{timeAgo(lastTrace.start_time)}</span>
          </div>
        )}
      </div>
    </button>
  );
}
