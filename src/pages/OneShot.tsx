import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { EventsList } from "@/components/EventsList";
import { getPhaseFromEvents, phaseLabel } from "../oneshot-helpers";
import type { SessionState } from "../types";

const defaultSession: SessionState = {
  running: false,
  events: [],
  trace: null,
  error: null,
};

export default function OneShot() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();

  const repos = useAppStore((s) => s.repos);
  const sessions = useAppStore((s) => s.sessions);

  const repo = repos.find((r) => r.id === repoId);
  const session = (repoId ? sessions.get(repoId) : undefined) ?? defaultSession;

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(repo?.model ?? "opus");
  const [mergeStrategy, setMergeStrategy] = useState("merge_to_main");

  const phase = useMemo(
    () => getPhaseFromEvents(session.events),
    [session.events],
  );

  const breadcrumbs = [
    { label: "Home", onClick: () => navigate("/") },
    { label: repo?.name ?? "Repo", onClick: () => navigate(`/repo/${repoId}`) },
    { label: "1-Shot" },
  ];

  if (!repo) {
    return (
      <main className="max-w-[700px] mx-auto p-8">
        <p>Repo not found</p>
      </main>
    );
  }

  function runOneShot() {
    const envVars = repo!.envVars ?? {};
    const repoArg =
      repo!.type === "ssh"
        ? { type: "ssh" as const, sshHost: repo!.sshHost, remotePath: repo!.remotePath }
        : { type: "local" as const, path: repo!.path };
    invoke("run_oneshot", {
      repoId: repo!.id,
      repo: repoArg,
      title,
      prompt,
      model,
      mergeStrategy,
      envVars,
    }).catch((e) => {
      console.error("Failed to start 1-shot:", e);
    });
  }

  async function stopSession() {
    try {
      await invoke("stop_session", { repoId });
    } catch (e) {
      console.error("Failed to stop session:", e);
    }
  }

  const repoPath = repo.type === "local" ? repo.path : repo.remotePath;

  const repoDisplayPath =
    repo.type === "local" ? repo.path : `${repo.sshHost}:${repo.remotePath}`;

  return (
    <main className="max-w-[700px] mx-auto p-8">
      <Breadcrumbs crumbs={breadcrumbs} />

      <header>
        <h1 className="text-3xl text-primary mb-0">{repo.name} — 1-Shot</h1>
        <p className="mt-1 text-muted-foreground text-sm font-mono">
          {repoDisplayPath}
        </p>
      </header>

      {!session.running && (
        <section className="form-section flex flex-col gap-3 mt-6">
          <div>
            <Label
              htmlFor="oneshot-title"
              className="text-sm text-muted-foreground"
            >
              Title
            </Label>
            <Input
              id="oneshot-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <Label
              htmlFor="oneshot-prompt"
              className="text-sm text-muted-foreground"
            >
              Prompt
            </Label>
            <Textarea
              id="oneshot-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
          <div>
            <Label
              htmlFor="oneshot-model"
              className="text-sm text-muted-foreground"
            >
              Model
            </Label>
            <Input
              id="oneshot-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-sm text-muted-foreground">
              Merge Strategy
            </Label>
            <div className="flex gap-6 mt-1">
              <label className="flex flex-row items-center gap-2 cursor-pointer text-foreground text-sm">
                <input
                  type="radio"
                  name="mergeStrategy"
                  value="merge_to_main"
                  checked={mergeStrategy === "merge_to_main"}
                  onChange={(e) => setMergeStrategy(e.target.value)}
                />
                Merge to main
              </label>
              <label className="flex flex-row items-center gap-2 cursor-pointer text-foreground text-sm">
                <input
                  type="radio"
                  name="mergeStrategy"
                  value="branch"
                  checked={mergeStrategy === "branch"}
                  onChange={(e) => setMergeStrategy(e.target.value)}
                />
                Create branch
              </label>
            </div>
          </div>
        </section>
      )}

      <div className="flex gap-2 mt-6">
        <Button
          type="button"
          disabled={session.running || !title.trim() || !prompt.trim()}
          onClick={runOneShot}
        >
          {session.running ? "Running..." : "Run"}
        </Button>
        {session.running && (
          <Button type="button" variant="destructive" onClick={stopSession}>
            Stop
          </Button>
        )}
      </div>

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

      <EventsList
        events={session.events}
        isLive={session.running}
        repoPath={repoPath}
      />

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

      {session.trace && (
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
