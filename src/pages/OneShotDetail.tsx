import { useMemo, useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EventsList } from "@/components/EventsList";
import { getPhaseFromEvents, phaseLabel } from "../oneshot-helpers";
import { groupEventsByIteration, maxContextPercent } from "../iteration-groups";
import { sessionContextColor } from "../context-bar";
import { Loader2, AlertTriangle, Terminal } from "lucide-react";
import { PlanPanel } from "../PlanPanel";
import type { SessionState, SessionTrace, SessionEvent } from "../types";

const defaultSession: SessionState = {
  running: false,
  events: [],
  trace: null,
  error: null,
};

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

function formatElapsed(trace: SessionTrace): string {
  if (!trace.start_time || !trace.end_time) return "";
  const start = new Date(trace.start_time).getTime();
  const end = new Date(trace.end_time).getTime();
  if (isNaN(start) || isNaN(end)) return "";
  const ms = end - start;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function statusBadge(
  entry: { status?: string } | undefined,
  phase: string,
  isRunning: boolean,
): { label: string; variant: "warning" | "completed" | "failed" | "secondary" } | null {
  if (entry?.status === "failed") return { label: "Failed", variant: "failed" };
  if (phase === "complete") return { label: "Complete", variant: "completed" };
  if (phase === "failed") return { label: "Failed", variant: "failed" };
  if (phase !== "idle") return { label: phaseLabel(phase), variant: "warning" };
  if (isRunning) return { label: "Running", variant: "warning" };
  return null;
}

export default function OneShotDetail() {
  const { oneshotId } = useParams<{ oneshotId: string }>();
  const navigate = useNavigate();

  const entries = useAppStore((s) => s.oneShotEntries);
  const sessions = useAppStore((s) => s.sessions);
  const resumeOneShot = useAppStore((s) => s.resumeOneShot);
  const repos = useAppStore((s) => s.repos);

  const [planPanelOpen, setPlanPanelOpen] = useState(false);

  const entry = oneshotId ? entries.get(oneshotId) : undefined;
  const session =
    (oneshotId ? sessions.get(oneshotId) : undefined) ?? defaultSession;

  const [fallbackTrace, setFallbackTrace] = useState<SessionTrace | null>(null);
  const [fallbackEvents, setFallbackEvents] = useState<SessionEvent[]>([]);
  const [fallbackLoading, setFallbackLoading] = useState(false);

  useEffect(() => {
    if (entry || !oneshotId) return;

    let cancelled = false;
    setFallbackLoading(true);

    invoke<SessionTrace[]>("list_traces", { repoId: oneshotId }).then(
      (traces) => {
        if (cancelled) return;
        if (!traces || traces.length === 0) {
          setFallbackLoading(false);
          return;
        }
        setFallbackTrace(traces[0]);
        invoke<SessionEvent[]>("get_trace_events", {
          repoId: oneshotId,
          sessionId: traces[0].session_id,
        })
          .then((events) => {
            if (!cancelled && events) {
              setFallbackEvents(events);
            }
          })
          .catch((e) => {
            console.error("Failed to load trace events from disk:", e);
          })
          .finally(() => {
            if (!cancelled) setFallbackLoading(false);
          });
      },
      (e) => {
        console.error("Failed to load traces from disk:", e);
        if (!cancelled) setFallbackLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [entry, oneshotId]);

  const displayTitle = entry?.title ?? fallbackTrace?.prompt.slice(0, 80) ?? "";
  const displayPrompt = entry?.prompt ?? fallbackTrace?.prompt ?? "";
  const displayParentName = entry?.parentRepoName;
  const displayEvents = entry ? session.events : fallbackEvents;
  const displayTrace = entry ? session.trace : fallbackTrace;
  const isRunning = entry ? session.running : false;
  const displayRepoPath = useMemo(() => {
    if (!entry?.worktreePath) return undefined;
    const parentRepo = repos.find((r) => r.id === entry.parentRepoId);
    if (parentRepo && parentRepo.type === "ssh") {
      return parentRepo.sshHost + ":" + entry.worktreePath;
    }
    return entry.worktreePath;
  }, [entry?.worktreePath, entry?.parentRepoId, repos]);

  const phase = useMemo(
    () => getPhaseFromEvents(displayEvents),
    [displayEvents],
  );

  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(displayEvents)),
    [displayEvents],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

  const status = statusBadge(entry, phase, isRunning);

  if (!entry && fallbackLoading) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Loader2 className="size-8 text-muted-foreground animate-spin mx-auto" />
      </main>
    );
  }

  if (!entry && !fallbackTrace) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <p>Not found</p>
      </main>
    );
  }

  const breadcrumbs = [
    { label: "Home", href: "/", onClick: () => navigate("/") },
    { label: displayTitle || "1-Shot" },
  ];

  async function stopSession() {
    try {
      await invoke("stop_session", { repoId: oneshotId });
    } catch (e) {
      console.error("Failed to stop session:", e);
      toast.error(`Failed to stop session: ${e}`);
    }
  }

  return (
    <main className="mx-auto p-8 space-y-4 max-w-[1100px]">
      <Breadcrumbs crumbs={breadcrumbs} />

      {/* Header card */}
      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-3xl font-bold text-foreground truncate">
              {displayTitle}
            </h1>
            {displayParentName && (
              <p className="mt-1 text-muted-foreground text-sm">
                from {displayParentName}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            {status && (
              <Badge variant={status.variant}>
                {isRunning && (
                  <span className="size-2 rounded-full bg-current motion-safe:animate-pulse" />
                )}
                {status.label}
              </Badge>
            )}
            {!isRunning && displayTrace && formatElapsed(displayTrace) && (
              <span className="text-sm text-muted-foreground font-mono">
                {formatElapsed(displayTrace)}
              </span>
            )}
            {isRunning && (
              <Button variant="destructive" size="sm" onClick={stopSession}>
                Stop
              </Button>
            )}
          </div>
        </div>

        {ctxPercent !== null && (
          <div className="flex items-center gap-2 mt-2">
            <div className="flex-1 h-1.5 bg-card-inset rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{
                  width: `${Math.min(ctxPercent, 100)}%`,
                  background: sessionContextColor(ctxPercent),
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground font-mono shrink-0">
              {ctxPercent}% ctx
            </span>
          </div>
        )}

        {displayTitle !== displayPrompt && (
          <div className="mt-3 p-3 bg-card-inset border border-border rounded font-mono text-sm text-muted-foreground whitespace-pre-wrap animate-in fade-in duration-200">
            {displayPrompt}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4 items-start">
        <div className="space-y-4">
          {/* Events */}
          {displayEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 rounded-md border border-dashed border-border text-center">
              {entry?.status === "running" ? (
                <>
                  <Loader2 className="size-8 text-muted-foreground mb-3 animate-spin" />
                  <p className="text-sm font-medium motion-safe:animate-pulse">
                    Session starting...
                  </p>
                </>
              ) : entry?.status === "failed" && entry.worktreePath ? (
                <>
                  <AlertTriangle className="size-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">Session was interrupted</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => resumeOneShot(oneshotId!)}
                  >
                    Resume
                  </Button>
                </>
              ) : entry?.status === "failed" ? (
                <>
                  <AlertTriangle className="size-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">
                    Session failed before starting
                  </p>
                </>
              ) : (
                <>
                  <Terminal className="size-8 text-muted-foreground mb-3" />
                  <p className="text-sm font-medium">No events recorded</p>
                </>
              )}
            </div>
          ) : (
            <EventsList
              events={displayEvents}
              isLive={isRunning}
              repoPath={displayRepoPath}
              planProgress={session.planProgress}
            />
          )}

          {/* Error */}
          {session.error && (
            <section className="bg-card border border-border rounded-lg p-4">
              <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
                Error
              </h2>
              <pre className="bg-destructive/10 text-destructive p-3 rounded font-mono text-sm overflow-x-auto whitespace-pre-wrap break-words">
                {session.error}
              </pre>
            </section>
          )}
        </div>

        {/* Result card */}
        {!isRunning && displayTrace && (
          <section className="bg-card border border-border rounded-lg p-4">
            <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
              Result
            </h2>
            <div className="space-y-0 divide-y divide-border">
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2 first:pt-0">
                <dt className="text-muted-foreground text-sm">Outcome</dt>
                <dd className="m-0 text-sm">
                  <Badge variant={outcomeBadge(displayTrace.outcome).variant}>
                    {outcomeBadge(displayTrace.outcome).label}
                  </Badge>
                </dd>
              </div>
              {displayTrace.failure_reason && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                  <dt className="text-muted-foreground text-sm">Reason</dt>
                  <dd className="m-0 text-sm text-destructive whitespace-pre-wrap break-words">
                    {displayTrace.failure_reason}
                  </dd>
                </div>
              )}
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Iterations</dt>
                <dd className="m-0 text-sm font-mono">
                  {displayTrace.total_iterations}
                </dd>
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Total Cost</dt>
                <dd className="m-0 text-sm font-mono">
                  ${displayTrace.total_cost_usd.toFixed(4)}
                </dd>
              </div>
              {ctxPercent !== null && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                  <dt className="text-muted-foreground text-sm">Peak Context</dt>
                  <dd className="m-0 text-sm font-mono">
                    <span style={{ color: sessionContextColor(ctxPercent) }}>
                      {ctxPercent}%
                    </span>
                  </dd>
                </div>
              )}
              {formatElapsed(displayTrace) && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                  <dt className="text-muted-foreground text-sm">Duration</dt>
                  <dd className="m-0 text-sm font-mono">
                    {formatElapsed(displayTrace)}
                  </dd>
                </div>
              )}
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Session ID</dt>
                <dd className="m-0 text-sm font-mono truncate" title={displayTrace.session_id}>
                  {displayTrace.session_id}
                </dd>
              </div>
              {session.trace?.plan_content && (
                <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                  <dt className="sr-only">Actions</dt>
                  <dd className="m-0 text-sm">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPlanPanelOpen(true)}
                    >
                      View Plan
                    </Button>
                  </dd>
                </div>
              )}
            </div>
          </section>
        )}
      </div>

      {session.trace?.plan_content && session.trace?.plan_file && (
        <PlanPanel
          open={planPanelOpen}
          onOpenChange={setPlanPanelOpen}
          planContent={session.trace.plan_content}
          planFile={session.trace.plan_file}
        />
      )}
    </main>
  );
}
