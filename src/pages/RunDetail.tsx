import { useState, useEffect, useRef } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { EventsList } from "@/components/EventsList";
import type { SessionTrace, SessionEvent } from "../types";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return (
    d.toLocaleDateString([], {
      year: "numeric",
      month: "short",
      day: "numeric",
    }) +
    " " +
    d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  );
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "\u2014";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

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

function planFilename(path: string | null): string {
  if (!path) return "\u2014";
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export default function RunDetail() {
  const { repoId, sessionId } = useParams<{
    repoId: string;
    sessionId: string;
  }>();
  const navigate = useNavigate();

  const [trace, setTrace] = useState<SessionTrace | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      invoke<SessionTrace>("get_trace", { repoId, sessionId }),
      invoke<SessionEvent[]>("get_trace_events", { repoId, sessionId }),
    ])
      .then(([traceResult, eventsResult]) => {
        if (!cancelled) {
          setTrace(traceResult);
          setEvents(eventsResult);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, sessionId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  function handleCopy() {
    if (!trace) return;
    navigator.clipboard.writeText(trace.session_id);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  const breadcrumbs = [
    { label: "Home", onClick: () => navigate("/") },
    { label: "History", onClick: () => navigate("/history") },
    { label: "Run " + sessionId },
  ];

  if (loading) {
    return (
      <main className="max-w-[700px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <div className="text-center text-muted-foreground py-12">
          <p>Loading...</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="max-w-[700px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <div>
          <pre className="bg-[#2d1b1b] text-red-400 p-3 rounded overflow-x-auto">
            {error}
          </pre>
        </div>
      </main>
    );
  }

  if (!trace) return null;

  const badge = outcomeBadge(trace.outcome);
  const totalInputTokens =
    trace.total_input_tokens +
    trace.total_cache_read_tokens +
    trace.total_cache_creation_tokens;

  return (
    <main className="max-w-[700px] mx-auto p-8">
      <Breadcrumbs crumbs={breadcrumbs} />

      <h1 className="text-3xl text-primary mb-0">Run Detail</h1>
      <p className="mt-1 text-muted-foreground text-sm">
        {formatDate(trace.start_time)}
      </p>

      <div className="summary">
        <h2 className="text-sm text-muted-foreground uppercase tracking-wide border-b border-border pb-1 mb-0">
          Summary
        </h2>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3">
          <dt className="text-muted-foreground text-sm">Outcome</dt>
          <dd className="m-0 text-sm">
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </dd>

          {trace.failure_reason && (
            <>
              <dt className="text-muted-foreground text-sm">Failure Reason</dt>
              <dd className="m-0 text-sm">{trace.failure_reason}</dd>
            </>
          )}

          <dt className="text-muted-foreground text-sm">Plan</dt>
          <dd className="m-0 text-sm">{planFilename(trace.plan_file)}</dd>

          <dt className="text-muted-foreground text-sm">Iterations</dt>
          <dd className="m-0 text-sm">{trace.total_iterations}</dd>

          <dt className="text-muted-foreground text-sm">Cost</dt>
          <dd className="m-0 text-sm">${trace.total_cost_usd.toFixed(4)}</dd>

          <dt className="text-muted-foreground text-sm">Duration</dt>
          <dd className="m-0 text-sm">
            {formatDuration(trace.start_time, trace.end_time)}
          </dd>

          <dt className="text-muted-foreground text-sm">Tokens</dt>
          <dd className="m-0 text-sm">
            {totalInputTokens.toLocaleString()} /{" "}
            {trace.total_output_tokens.toLocaleString()}
          </dd>

          <dt className="text-muted-foreground text-sm">Session ID</dt>
          <dd className="m-0 text-sm">
            <span>{trace.session_id}</span>
            <button
              className="text-xs px-1.5 py-0.5 bg-secondary text-muted-foreground border border-border rounded cursor-pointer ml-2 align-middle"
              onClick={handleCopy}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </dd>
        </dl>
      </div>

      <EventsList events={events} repoPath={trace.repo_path} />
    </main>
  );
}
