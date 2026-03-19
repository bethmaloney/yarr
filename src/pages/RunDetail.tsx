import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EventsList } from "@/components/EventsList";
import { PlanPanel } from "../PlanPanel";
import { parsePlanPreview, planDisplayName } from "../plan-preview";
import { parsePlanProgress } from "../plan-progress";
import { groupEventsByIteration, maxContextPercent } from "../iteration-groups";
import { sessionContextColor } from "../context-bar";
import { Loader2 } from "lucide-react";
import { useAppStore } from "../store";
import { repoPayload } from "../repos";
import type { SessionTrace, SessionEvent } from "../types";

function planFilename(path: string | null): string {
  if (!path) return "\u2014";
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  let name = parts[parts.length - 1] || path;
  name = name.replace(/\.[^.]+$/, "");
  name = name.replace(/^\d{4}-\d{2}-\d{2}[-_]/, "");
  name = name.replace(/[_-]/g, " ");
  return name;
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

export default function RunDetail() {
  const { repoId, sessionId } = useParams<{
    repoId: string;
    sessionId: string;
  }>();
  const navigate = useNavigate();
  const repos = useAppStore((s) => s.repos);
  const repo = repos.find((r) => r.id === repoId);

  const [trace, setTrace] = useState<SessionTrace | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [planParsed, setPlanParsed] = useState<{
    name: string;
    excerpt: string;
  } | null>(null);
  const [planPanelOpen, setPlanPanelOpen] = useState(false);

  const planProgress = useMemo(
    () => (trace?.plan_content ? parsePlanProgress(trace.plan_content) : null),
    [trace?.plan_content],
  );

  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(events)),
    [events],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

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
        console.warn("[RunDetail] failed to load trace/events:", e);
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

  const tracePlanFile = trace?.plan_file ?? null;
  useEffect(() => {
    if (!tracePlanFile || !repo) {
      setPlanParsed(null);
      return;
    }
    const currentPath = tracePlanFile;
    const payload = repoPayload(repo);

    function tryPath(path: string) {
      return invoke("read_file_preview", { repo: payload, path, maxLines: 8 }).then(
        (result) => result as string,
      );
    }

    function completedVariant(path: string): string {
      const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      if (lastSep < 0) return "completed/" + path;
      return path.slice(0, lastSep) + "/completed" + path.slice(lastSep);
    }

    tryPath(currentPath)
      .catch(() => tryPath(completedVariant(currentPath)))
      .then((content) => {
        if (currentPath === tracePlanFile) {
          setPlanParsed(parsePlanPreview(content));
        }
      })
      .catch((e) => {
        console.warn("[RunDetail] failed to load plan preview:", e);
        if (currentPath === tracePlanFile) {
          setPlanParsed(null);
        }
      });
  }, [tracePlanFile, repo]);

  function handleCopy() {
    if (!trace) return;
    navigator.clipboard.writeText(trace.session_id);
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  const displayTitle = trace
    ? planFilename(trace.plan_file) !== "\u2014"
      ? planFilename(trace.plan_file)
      : trace.title ?? trace.prompt?.slice(0, 80) ?? `Run ${sessionId}`
    : `Run ${sessionId}`;

  const breadcrumbs = [
    { label: "Home", onClick: () => navigate("/") },
    { label: "History", onClick: () => navigate("/history") },
    { label: displayTitle },
  ];

  if (loading) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <Loader2 className="size-8 text-muted-foreground animate-spin mx-auto mt-12" />
      </main>
    );
  }

  if (error) {
    return (
      <main className="max-w-[1100px] mx-auto p-8">
        <Breadcrumbs crumbs={breadcrumbs} />
        <pre className="bg-destructive/10 text-destructive p-3 rounded overflow-x-auto whitespace-pre-wrap break-words">
          {error}
        </pre>
      </main>
    );
  }

  if (!trace) return null;

  const badge = outcomeBadge(trace.outcome);
  const elapsed = formatDuration(trace.start_time, trace.end_time);
  const totalInputTokens =
    trace.total_input_tokens +
    trace.total_cache_read_tokens +
    trace.total_cache_creation_tokens;

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
          </div>
          <div className="flex items-center gap-2 shrink-0 pt-1">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {elapsed !== "\u2014" && (
              <span className="text-sm text-muted-foreground font-mono">
                {elapsed}
              </span>
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

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        {/* Events */}
        <EventsList
          events={events}
          repoPath={trace.repo_path}
          planProgress={planProgress}
        />

        {/* Result sidebar */}
        <section className="bg-card border border-border rounded-lg p-4">
          <h2 className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-3">
            Result
          </h2>
          <div className="space-y-0 divide-y divide-border">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2 first:pt-0">
              <dt className="text-muted-foreground text-sm">Outcome</dt>
              <dd className="m-0 text-sm">
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </dd>
            </div>

            {trace.failure_reason && (
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Reason</dt>
                <dd className="m-0 text-sm text-destructive whitespace-pre-wrap break-words">
                  {trace.failure_reason}
                </dd>
              </div>
            )}

            {(trace.plan_file || trace.plan_content) && (
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Plan</dt>
                <dd className="m-0 text-sm">
                  {trace.plan_content ? (
                    <span
                      className="cursor-pointer hover:underline"
                      role="button"
                      onClick={() => setPlanPanelOpen(true)}
                    >
                      {planDisplayName(trace.plan_file, planParsed?.name)}
                    </span>
                  ) : (
                    planDisplayName(trace.plan_file, planParsed?.name)
                  )}
                </dd>
              </div>
            )}

            <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
              <dt className="text-muted-foreground text-sm">Iterations</dt>
              <dd className="m-0 text-sm font-mono">
                {trace.total_iterations}
              </dd>
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
              <dt className="text-muted-foreground text-sm">Total Cost</dt>
              <dd className="m-0 text-sm font-mono">
                ${trace.total_cost_usd.toFixed(4)}
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

            {elapsed !== "\u2014" && (
              <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
                <dt className="text-muted-foreground text-sm">Duration</dt>
                <dd className="m-0 text-sm font-mono">{elapsed}</dd>
              </div>
            )}

            <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
              <dt className="text-muted-foreground text-sm">Tokens</dt>
              <dd className="m-0 text-sm font-mono">
                {totalInputTokens.toLocaleString()} /{" "}
                {trace.total_output_tokens.toLocaleString()}
              </dd>
            </div>

            <div className="grid grid-cols-[auto_1fr] gap-x-4 py-2">
              <dt className="text-muted-foreground text-sm">Session ID</dt>
              <dd className="m-0 text-sm font-mono truncate" title={trace.session_id}>
                {trace.session_id}
                <button
                  className="text-xs px-1.5 py-0.5 bg-secondary text-muted-foreground border border-border rounded cursor-pointer ml-2 align-middle"
                  onClick={handleCopy}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </dd>
            </div>

            {trace.plan_content && (
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
      </div>

      {trace.plan_content && trace.plan_file && (
        <PlanPanel
          open={planPanelOpen}
          onOpenChange={setPlanPanelOpen}
          planContent={trace.plan_content}
          planFile={trace.plan_file}
        />
      )}
    </main>
  );
}
