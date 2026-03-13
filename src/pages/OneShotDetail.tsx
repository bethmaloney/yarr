import { useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Button } from "@/components/ui/button";
import { EventsList } from "@/components/EventsList";
import { getPhaseFromEvents, phaseLabel } from "../oneshot-helpers";
import { groupEventsByIteration, maxContextPercent } from "../iteration-groups";
import { sessionContextColor } from "../context-bar";
import { Loader2, AlertTriangle, Terminal } from "lucide-react";
import type { SessionState } from "../types";

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

  const entry = oneshotId ? entries.get(oneshotId) : undefined;
  const session =
    (oneshotId ? sessions.get(oneshotId) : undefined) ?? defaultSession;

  const phase = useMemo(
    () => getPhaseFromEvents(session.events),
    [session.events],
  );

  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(session.events)),
    [session.events],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

  const repoPath = entry?.worktreePath;

  if (!entry) {
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
    }
  }

  return (
    <main className="max-w-[700px] mx-auto p-8">
      <Breadcrumbs crumbs={breadcrumbs} />

      <header>
        <h1 className="text-3xl text-primary mb-0">{entry.title}</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          from {entry.parentRepoName}
        </p>
      </header>

      <div className="mt-4 p-3 bg-card border border-border rounded font-mono text-sm text-muted-foreground whitespace-pre-wrap">
        {entry.prompt}
      </div>

      {session.running && (
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

      {session.events.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-md border border-dashed border-border text-center mt-4">
          {entry.status === "running" ? (
            <>
              <Loader2 className="size-8 text-muted-foreground mb-3 animate-spin" />
              <p className="text-sm font-medium animate-pulse">Session starting...</p>
            </>
          ) : entry.status === "failed" && entry.worktreePath ? (
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
          ) : entry.status === "failed" ? (
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
          events={session.events}
          isLive={session.running}
          repoPath={repoPath}
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

      {!session.running && session.trace && (
        <section>
          <h2 className="text-sm text-muted-foreground uppercase tracking-wide border-b border-border pb-1 mb-0">
            Result
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3">
            <dt className="text-muted-foreground text-sm">Outcome</dt>
            <dd className="m-0 text-sm font-mono">{session.trace.outcome}</dd>
            {session.trace.failure_reason && (
              <>
                <dt className="text-muted-foreground text-sm">Reason</dt>
                <dd className="m-0 text-sm font-mono text-red-400 whitespace-pre-wrap break-words">
                  {session.trace.failure_reason}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground text-sm">Iterations</dt>
            <dd className="m-0 text-sm font-mono">
              {session.trace.total_iterations}
            </dd>
            <dt className="text-muted-foreground text-sm">Total Cost</dt>
            <dd className="m-0 text-sm font-mono">
              ${session.trace.total_cost_usd.toFixed(4)}
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
              {session.trace.session_id}
            </dd>
          </dl>
        </section>
      )}
    </main>
  );
}
