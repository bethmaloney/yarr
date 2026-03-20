import { useMemo, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parsePlanProgress } from "./plan-progress";
import { planDisplayName, parsePlanPreview } from "./plan-preview";
import { CheckCircle2, Circle, CircleDot } from "lucide-react";

interface PlanPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planContent: string;
  planFile: string;
}

function basename(filepath: string): string {
  const parts = filepath.split(/[/\\]/);
  return parts[parts.length - 1] || filepath;
}

export function PlanPanel({
  open,
  onOpenChange,
  planContent,
  planFile,
}: PlanPanelProps) {
  const progress = useMemo(() => parsePlanProgress(planContent), [planContent]);

  const preview = useMemo(() => parsePlanPreview(planContent), [planContent]);

  const displayName = useMemo(
    () => planDisplayName(planFile, preview.name),
    [planFile, preview.name],
  );

  const scrollToTask = useCallback((taskNum: number) => {
    const el = document.getElementById(`plan-task-${taskNum}`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const mdComponents: Components = useMemo(
    () => ({
      h2: ({ children, ...props }) => {
        const text = String(children);
        const taskMatch = text.match(
          /^(?:Task\s+)?(\d+)[:\s\u2014\u2013-]*(.*)/i,
        );
        if (taskMatch) {
          const num = parseInt(taskMatch[1], 10);
          const task = progress?.tasks.find((t) => t.number === num);
          const done = task && task.completed === task.total;
          const active = task && progress?.currentTask?.number === task.number;
          return (
            <h2
              id={`plan-task-${num}`}
              className="plan-task-heading scroll-mt-24"
              {...props}
            >
              <span className="plan-task-icon">
                {done ? (
                  <CheckCircle2 className="size-4 text-success" />
                ) : active ? (
                  <CircleDot className="size-4 text-info" />
                ) : task ? (
                  <Circle className="size-4 text-muted-foreground" />
                ) : null}
              </span>
              {children}
              {task && (
                <span className="plan-task-count">
                  {task.completed}/{task.total}
                </span>
              )}
            </h2>
          );
        }
        return <h2 {...props}>{children}</h2>;
      },

      h3: ({ children, ...props }) => {
        const text = String(children);
        const taskMatch = text.match(
          /^(?:Task\s+)?(\d+)[:\s\u2014\u2013-]*(.*)/i,
        );
        if (taskMatch) {
          const num = parseInt(taskMatch[1], 10);
          return (
            <h3 id={`plan-task-${num}`} className="scroll-mt-24" {...props}>
              {children}
            </h3>
          );
        }
        return <h3 {...props}>{children}</h3>;
      },

      input: ({ type, checked, ...props }) => {
        if (type === "checkbox") {
          return checked ? (
            <CheckCircle2 className="plan-check plan-check-done" />
          ) : (
            <Circle className="plan-check plan-check-pending" />
          );
        }
        return <input type={type} checked={checked} {...props} />;
      },
    }),
    [progress],
  );

  const pct = progress
    ? Math.round((progress.completedItems / progress.totalItems) * 100)
    : null;
  const isComplete = progress
    ? progress.completedItems === progress.totalItems
    : false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="overflow-y-auto border-l border-border bg-card sm:max-w-2xl"
        aria-describedby="plan-panel-description"
      >
        <SheetHeader className="plan-header sticky top-0 z-10 bg-card pb-3 -mx-[1px] border-b border-border">
          <SheetTitle className="text-lg text-primary-light">
            {displayName}
          </SheetTitle>
          <SheetDescription
            id="plan-panel-description"
            className="font-mono text-xs"
          >
            {basename(planFile)}
          </SheetDescription>

          {progress && pct !== null && (
            <div className="flex items-center gap-3 mt-1">
              <div className="flex-1 h-1.5 rounded-full bg-card-inset overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width] duration-300 ${isComplete ? "bg-success" : "bg-info"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                {pct}% &middot; {progress.completedItems}/{progress.totalItems}
              </span>
            </div>
          )}

          {progress && progress.tasks.length > 1 && (
            <div className="flex gap-1.5 mt-1 overflow-x-auto pb-0.5">
              {progress.tasks.map((task) => {
                const done = task.completed === task.total;
                const active =
                  !done && progress.currentTask?.number === task.number;
                return (
                  <button
                    key={task.number}
                    onClick={() => scrollToTask(task.number)}
                    className={[
                      "flex items-center gap-1 px-2 py-0.5 rounded-sm text-xs font-mono",
                      "whitespace-nowrap cursor-pointer transition-colors duration-150 border",
                      done
                        ? "border-success/30 text-success bg-[oklch(0.25_0.04_165)]"
                        : active
                          ? "border-info/30 text-info bg-[oklch(0.25_0.03_250)]"
                          : "border-border text-muted-foreground hover:border-border-hover hover:text-foreground",
                    ].join(" ")}
                  >
                    {done ? (
                      <CheckCircle2 className="size-3" />
                    ) : active ? (
                      <CircleDot className="size-3" />
                    ) : (
                      <Circle className="size-3" />
                    )}
                    T{task.number}
                    <span className="opacity-50">
                      {task.completed}/{task.total}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </SheetHeader>

        <div className="plan-prose prose prose-invert max-w-none px-4 pb-6">
          <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {planContent}
          </Markdown>
        </div>
      </SheetContent>
    </Sheet>
  );
}
