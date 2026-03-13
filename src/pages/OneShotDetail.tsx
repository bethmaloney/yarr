import { useMemo, useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
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

export default function OneShotDetail() {
  const { oneshotId } = useParams<{ oneshotId: string }>();
  const navigate = useNavigate();

  const entries = useAppStore((s) => s.oneShotEntries);
  const sessions = useAppStore((s) => s.sessions);
  const resumeOneShot = useAppStore((s) => s.resumeOneShot);

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

  const displayTitle =
    entry?.title ?? fallbackTrace?.prompt.slice(0, 80) ?? "";
  const displayPrompt = entry?.prompt ?? fallbackTrace?.prompt ?? "";
  const displayParentName = entry?.parentRepoName ?? "Unknown";
  const displayEvents = entry ? session.events : fallbackEvents;
  const displayTrace = entry ? session.trace : fallbackTrace;
  const isRunning = entry ? session.running : false;
  const displayRepoPath = entry?.worktreePath;

  const phase = useMemo(
    () => getPhaseFromEvents(displayEvents),
    [displayEvents],
  );

  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(displayEvents)),
    [displayEvents],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

  if (!entry && fallbackLoading) {
    return (
      <main className="max-w-[700px] mx-auto p-8">
        <Loader2 className="size-8 text-muted-foreground animate-spin mx-auto" />
      </main>
    );
  }

  if (!entry && !fallbackTrace) {
    return (
      <main className="max-w-[700px] mx-auto p-8">
        <p>Not found</p>
      </main>
    );
  }

  const breadcrumbs = [
    { label: "Home", onClick: () => navigate("/") },
    { label: "1-Shot" },
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
    <main className="max-w-[700px] mx-auto p-8">
      <Breadcrumbs crumbs={breadcrumbs} />

      <header>
        <h1 className="text-3xl text-primary mb-0">{displayTitle}</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          from {displayParentName}
        </p>
      </header>

      {displayTitle !== displayPrompt && (
        <div className="mt-4 p-3 bg-card border border-border rounded font-mono text-sm text-muted-foreground whitespace-pre-wrap">
          {displayPrompt}
        </div>
      )}

      {isRunning && (
        <div className="flex gap-2 mt-4">
          <Button variant="destructive" onClick={stopSession}>
            Stop
          </Button>
        </div>
      )}

      {phase !== "idle" && (
        <div
          className={`phase-indicator mt-4 p-3 bg-card border border-border rounded font-mono text-sm text-primary ${
            phase === "failed"
              ? "failed text-red-400 border-red-400"
              : phase === "complete"
                ? "complete text-emerald-400 border-emerald-400"
                : ""
          }`}
        >
          {phaseLabel(phase)}
        </div>
      )}

      {displayEvents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-md border border-dashed border-border text-center mt-4">
          {entry?.status === "running" ? (
            <>
              <Loader2 className="size-8 text-muted-foreground mb-3 animate-spin" />
              <p className="text-sm font-medium animate-pulse">Session starting...</p>
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
              <p className="text-sm font-medium">Session failed before starting</p>
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
        />
      )}

      {session.error && (
        <section>
          <h2 className="text-sm text-muted-foreground uppercase tracking-wide border-b border-border pb-1 mb-0">
            Error
          </h2>
          <pre className="bg-[#2d1b1b] text-red-400 p-3 rounded overflow-x-auto">
            {session.error}
          </pre>
        </section>
      )}

      {!isRunning && displayTrace && (
        <section>
          <h2 className="text-sm text-muted-foreground uppercase tracking-wide border-b border-border pb-1 mb-0">
            Result
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3">
            <dt className="text-muted-foreground text-sm">Outcome</dt>
            <dd className="m-0 text-sm font-mono">{displayTrace.outcome}</dd>
            {displayTrace.failure_reason && (
              <>
                <dt className="text-muted-foreground text-sm">Reason</dt>
                <dd className="m-0 text-sm font-mono text-red-400 whitespace-pre-wrap break-words">
                  {displayTrace.failure_reason}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground text-sm">Iterations</dt>
            <dd className="m-0 text-sm font-mono">
              {displayTrace.total_iterations}
            </dd>
            <dt className="text-muted-foreground text-sm">Total Cost</dt>
            <dd className="m-0 text-sm font-mono">
              ${displayTrace.total_cost_usd.toFixed(4)}
            </dd>
            {ctxPercent !== null && (
              <>
                <dt className="text-muted-foreground text-sm">Peak Context</dt>
                <dd className="m-0 text-sm font-mono">
                  <span style={{ color: sessionContextColor(ctxPercent) }}>
                    {ctxPercent}%
                  </span>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground text-sm">Session ID</dt>
            <dd className="m-0 text-sm font-mono">
              {displayTrace.session_id}
            </dd>
            {session.trace.plan_content && (
              <>
                <dt className="sr-only">Actions</dt>
                <dd className="m-0 text-sm">
                  <Button variant="outline" size="sm" onClick={() => setPlanPanelOpen(true)}>
                    View Plan
                  </Button>
                </dd>
              </>
            )}
          </dl>
        </section>
      )}

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
