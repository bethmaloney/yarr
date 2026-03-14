import type { PlanProgress } from "../plan-progress";

interface PlanProgressBarProps {
  progress: PlanProgress;
}

export function PlanProgressBar({ progress }: PlanProgressBarProps) {
  const { totalItems, completedItems, currentTask } = progress;
  const pct = Math.round((completedItems / totalItems) * 100);
  const isComplete = completedItems === totalItems;

  return (
    <div className="mb-2">
      <div className="h-1 rounded-full bg-card-inset overflow-hidden">
        <div
          data-testid="progress-fill"
          className={`h-full rounded-full ${isComplete ? "bg-success" : "bg-info"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-muted-foreground font-mono text-xs">
        {pct}% · {completedItems}/{totalItems} items
      </div>
      <div className="text-muted-foreground font-mono text-xs">
        {currentTask
          ? `Next: Task ${currentTask.number} — ${currentTask.title}`
          : "All tasks complete"}
      </div>
    </div>
  );
}
