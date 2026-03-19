import type { PlanProgress } from "../plan-progress";

interface PlanProgressBarProps {
  progress: PlanProgress;
}

export function PlanProgressBar({ progress }: PlanProgressBarProps) {
  const { totalItems, completedItems, currentTask } = progress;
  const pct = Math.round((completedItems / totalItems) * 100);
  const isComplete = completedItems === totalItems;

  return (
    <div className="flex items-center gap-3 rounded-md bg-card-inset px-3 py-1.5 mb-2">
      <div className="w-20 h-1.5 rounded-full bg-background overflow-hidden flex-shrink-0">
        <div
          data-testid="progress-fill"
          className={`h-full rounded-full ${isComplete ? "bg-success" : "bg-info"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
        {pct}% · {completedItems}/{totalItems} items
      </span>
      <span
        className={`text-xs font-mono truncate border-l border-border pl-3 ${isComplete ? "text-success" : "text-muted-foreground"}`}
      >
        {currentTask
          ? `Next: Task ${currentTask.number} — ${currentTask.title}`
          : "All tasks complete"}
      </span>
    </div>
  );
}
