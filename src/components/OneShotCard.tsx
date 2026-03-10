import { phaseLabel } from "../oneshot-helpers";
import { timeAgo } from "../time";
import type { OneShotEntry } from "../types";

interface OneShotCardProps {
  entry: OneShotEntry;
  phase: string;
  onClick: () => void;
  onDismiss?: () => void;
}

function phaseColor(phase: string): string {
  switch (phase) {
    case "design":
    case "implementation":
    case "starting":
    case "design_complete":
    case "implementation_complete":
    case "finalizing":
      return "#e8d44d";
    case "complete":
      return "#34d399";
    case "failed":
      return "#f87171";
    default:
      return "#888";
  }
}

export function OneShotCard({
  entry,
  phase,
  onClick,
  onDismiss,
}: OneShotCardProps) {
  const color = phaseColor(phase);
  const label = phaseLabel(phase);
  const showDismiss = entry.status === "failed" && onDismiss != null;

  const dotClassName = [
    "w-2 h-2 rounded-full shrink-0",
    entry.status === "running" ? "animate-pulse" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex flex-col gap-1.5 p-4 px-5 bg-card border border-border rounded-md cursor-pointer text-left w-full h-full transition-colors hover:border-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`${entry.title} \u2014 1-Shot`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-lg font-semibold text-foreground truncate">
          {entry.title}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
          1-Shot
        </span>
        {showDismiss && (
          <button
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground text-xs"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
            &times;
          </button>
        )}
      </div>

      <span className="text-xs text-muted-foreground truncate">
        from {entry.parentRepoName}
      </span>

      <p className="text-xs text-muted-foreground line-clamp-2">
        {entry.prompt}
      </p>

      <div className="flex-1" />

      <div className="flex items-center gap-2 min-w-0">
        <span className={dotClassName} style={{ background: color }} />
        <span
          className="text-xs font-medium tracking-wider"
          style={{ color }}
        >
          {label}
        </span>
        <span className="ml-auto text-xs text-muted-foreground shrink-0">
          {timeAgo(new Date(entry.startedAt).toISOString())}
        </span>
      </div>
    </div>
  );
}
