import { timeAgo } from "../time";
import { sessionContextColor } from "../context-bar";
import type { RepoConfig } from "../repos";
import type { RepoStatus, SessionTrace } from "../types";

interface RepoCardProps {
  repo: RepoConfig;
  status: RepoStatus;
  lastTrace?: SessionTrace;
  branchName?: string;
  onClick: () => void;
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

export function RepoCard({
  repo,
  status,
  lastTrace,
  branchName,
  onClick,
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

  return (
    <button
      className="flex flex-col gap-3 p-4 px-5 bg-card border border-border rounded-md cursor-pointer text-left w-full transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      onClick={onClick}
      aria-label={`${repo.name} \u2014 ${statusLabels[status]}`}
    >
      <div className="flex flex-col gap-1">
        <span className="text-lg font-semibold text-foreground truncate">
          {repo.name}
        </span>
        <span className="text-xs text-muted-foreground font-mono truncate">
          {repoFullPath}
        </span>
        {branchName && (
          <span className="text-xs text-gray-500 font-mono truncate">
            {branchName}
          </span>
        )}
      </div>

      {lastTrace && (
        <div className="text-xs text-muted-foreground flex items-center gap-0">
          {lastTrace.plan_file && (
            <>
              <span className="font-mono">
                {lastTrace.plan_file.split(/[\\/]/).pop()}
              </span>
              <span className="separator"> &middot; </span>
            </>
          )}
          <span>${(lastTrace.total_cost_usd ?? 0).toFixed(2)}</span>
          {lastTrace.context_window &&
            (() => {
              const ctxPct = Math.round(
                ((lastTrace.final_context_tokens ?? 0) /
                  lastTrace.context_window) *
                  100,
              );
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

      <div className="flex items-center gap-2">
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
      </div>
    </button>
  );
}
