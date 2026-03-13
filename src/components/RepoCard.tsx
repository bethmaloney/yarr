import { timeAgo } from "../time";
import { sessionContextColor } from "../context-bar";
import type { RepoConfig } from "../repos";
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
  onClick: () => void;
  onPlanClick?: () => void;
}

const statusColors: Record<RepoStatus, string> = {
  idle: "#888",
  running: "#e8d44d",
  completed: "#34d399",
  failed: "#f87171",
  disconnected: "#f59e0b",
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
  onClick,
  onPlanClick,
}: RepoCardProps) {
  const repoFullPath =
    repo.type === "ssh" ? `${repo.sshHost}:${repo.remotePath}` : repo.path;

  const dotClassName = [
    "w-2 h-2 rounded-full shrink-0",
    status === "running" ? "animate-pulse" : "",
    status === "disconnected" ? "animate-blink" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const gs = gitStatus?.status;
  const indicators: React.ReactNode[] = [];
  if (gs) {
    if (gs.dirtyCount > 0) {
      indicators.push(
        <span key="dirty">{gs.dirtyCount} dirty</span>,
      );
    }
    if (gs.ahead != null && gs.ahead > 0) {
      indicators.push(
        <span key="ahead">
          {gs.ahead}&#x2191;
        </span>,
      );
    }
    if (gs.behind != null && gs.behind > 0) {
      indicators.push(
        <span key="behind" className="text-yellow-500">
          {gs.behind}&#x2193;
        </span>,
      );
    }
  }

  return (
    <button
      className="flex flex-col gap-1.5 p-4 px-5 bg-card border border-border rounded-md cursor-pointer text-left w-full h-full transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      onClick={onClick}
      aria-label={`${repo.name} \u2014 ${statusLabels[status]}`}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <span className="text-lg font-semibold text-foreground truncate">
          {repo.name}
        </span>
        <span className="text-xs text-muted-foreground font-mono truncate">
          {repoFullPath}
        </span>
        {gitStatus?.loading && !gs && (
          <span className="text-xs text-gray-500 font-mono truncate">
            Loading...
          </span>
        )}
        {gitStatus?.error && !gs && (
          <span className="text-xs text-gray-500 font-mono truncate">
            &#x26A0;
          </span>
        )}
        {gs && (
          <span className="text-xs text-gray-500 font-mono truncate">
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
          <span className="text-xs text-gray-500 font-mono truncate">
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

      <div className="flex items-center gap-2 min-w-0">
        <span
          className={dotClassName}
          style={{ background: statusColors[status] }}
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
                  lastTrace.max_context_percent && lastTrace.max_context_percent > 0
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
