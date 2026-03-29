import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open, ask } from "@tauri-apps/plugin-dialog";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useAppStore } from "../store";
import { useGitStatus } from "../hooks/useGitStatus";
import { getPhaseFromEvents, phaseLabel } from "../oneshot-helpers";
import { parsePlanPreview } from "../plan-preview";
import { repoPayload } from "../repos";
import { timeAgo } from "../time";
import { PlanPanel } from "../PlanPanel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { OneShotCard } from "@/components/OneShotCard";
import { RepoCard } from "@/components/RepoCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import type { RepoStatus } from "../types";

export default function Home() {
  const repos = useAppStore((s) => s.repos);
  const sessions = useAppStore((s) => s.sessions);
  const latestTraces = useAppStore((s) => s.latestTraces);
  const addLocalRepo = useAppStore((s) => s.addLocalRepo);
  const addSshRepo = useAppStore((s) => s.addSshRepo);
  const oneShotEntries = useAppStore((s) => s.oneShotEntries);
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const updateDownloading = useAppStore((s) => s.updateDownloading);
  const installUpdate = useAppStore((s) => s.installUpdate);
  const removeRepo = useAppStore((s) => s.removeRepo);

  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<null | "choosing" | "ssh-form">(null);
  const [sshHost, setSshHost] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");

  const [planPreviews, setPlanPreviews] = useState<Map<string, string>>(
    new Map(),
  );

  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const [planPanelContent, setPlanPanelContent] = useState<string | null>(null);
  const [planPanelFile, setPlanPanelFile] = useState<string | null>(null);

  useGitStatus(repos, sessions);
  const gitStatus = useAppStore((s) => s.gitStatus);
  const navigate = useNavigate();

  useEffect(() => {
    getVersion()
      .then((v) => setAppVersion(v))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const fetchPreviews = async () => {
      const newMap = new Map<string, string>();
      for (const [repoId, trace] of latestTraces) {
        if (!trace.plan_file) continue;
        const repo = repos.find((r) => r.id === repoId);
        if (!repo) continue;
        try {
          const result = await invoke("read_file_preview", {
            repo: repoPayload(repo),
            path: trace.plan_file,
            maxLines: 8,
          });
          const parsed = parsePlanPreview(result as string);
          if (parsed.excerpt) {
            newMap.set(repoId, parsed.excerpt);
          }
        } catch (e) {
          console.warn("[Home] failed to load plan preview:", e);
        }
      }
      setPlanPreviews(newMap);
    };
    fetchPreviews();
  }, [latestTraces, repos]);

  function deriveStatus(repoId: string): RepoStatus {
    const session = sessions.get(repoId);
    if (!session) return "idle";
    if (session.disconnected) return "disconnected";
    if (session.reconnecting) return "running";
    if (session.error) return "failed";
    if (session.running) return "running";
    if (session.trace) return "completed";
    return "idle";
  }

  // Build unified sorted list of all cards
  type CardItem =
    | {
        type: "repo";
        key: string;
        isRunning: boolean;
        timestamp: number;
        repo: (typeof repos)[number];
        status: RepoStatus;
      }
    | {
        type: "oneshot";
        key: string;
        isRunning: boolean;
        timestamp: number;
        entry: NonNullable<ReturnType<typeof oneShotEntries.get>>;
        phase: string;
      };

  const cardItems: CardItem[] = [];

  for (const repo of repos) {
    const status = deriveStatus(repo.id);
    const trace = latestTraces.get(repo.id);
    const timestamp = trace?.start_time ? Date.parse(trace.start_time) : 0;
    cardItems.push({
      type: "repo",
      key: repo.id,
      isRunning: status === "running",
      timestamp,
      repo,
      status,
    });
  }

  for (const [, entry] of oneShotEntries) {
    const events = sessions.get(entry.id)?.events ?? [];
    let phase = getPhaseFromEvents(events);
    // When session events are gone (e.g. after restart), fall back to entry.status
    if (phase === "idle" && entry.status === "completed") phase = "complete";
    if (phase === "idle" && entry.status === "failed") phase = "failed";
    cardItems.push({
      type: "oneshot",
      key: entry.id,
      isRunning: entry.status === "running",
      timestamp: entry.startedAt,
      entry,
      phase,
    });
  }

  // Separate completed/failed one-shots from active items
  const activeItems: CardItem[] = [];
  const completedOneShots: (CardItem & { type: "oneshot" })[] = [];

  for (const item of cardItems) {
    if (
      item.type === "oneshot" &&
      (item.entry.status === "completed" || item.entry.status === "failed")
    ) {
      completedOneShots.push(item);
    } else {
      activeItems.push(item);
    }
  }

  activeItems.sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    return b.timestamp - a.timestamp;
  });

  completedOneShots.sort((a, b) => b.timestamp - a.timestamp);

  const [completedOpen, setCompletedOpen] = useState(true);

  function openPlanPanel(repoId: string): (() => void) | undefined {
    const trace = latestTraces.get(repoId);
    if (!trace?.plan_content || !trace?.plan_file) return undefined;
    return () => {
      setPlanPanelContent(trace.plan_content!);
      setPlanPanelFile(trace.plan_file!);
      setPlanPanelOpen(true);
    };
  }

  function handleAddRepo() {
    setAddMode("choosing");
  }

  async function handleChooseLocal() {
    setAddMode(null);
    try {
      const result = await open({
        directory: true,
        title: "Select repository",
      });
      if (result !== null) {
        await addLocalRepo(result);
      }
    } catch (err) {
      console.error("Failed to add local repo:", err);
    }
  }

  function handleChooseSsh() {
    setSshHost("");
    setSshRemotePath("");
    setAddMode("ssh-form");
  }

  function handleCancelAdd() {
    setAddMode(null);
  }

  async function handleAddSshRepo() {
    const host = sshHost.trim();
    const path = sshRemotePath.trim();
    if (!host || !path) return;
    try {
      await addSshRepo(host, path);
    } catch (err) {
      console.error("Failed to add SSH repo:", err);
    }
    setAddMode(null);
  }

  async function handleRemoveRepo(repoId: string, repoName: string) {
    try {
      const confirmed = await ask(
        `Remove "${repoName}" from Yarr? The repository on disk will not be affected.`,
        { title: "Remove Repository?", kind: "warning" },
      );
      if (!confirmed) return;
      await removeRepo(repoId);
      toast.success("Repository removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <main className="max-w-[900px] mx-auto p-8">
      <Breadcrumbs crumbs={[{ label: "Home" }]} />
      <header className="toolbar-header flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl text-primary font-bold">Yarr</h1>
          <p className="subtitle text-sm text-muted-foreground mt-1">
            Yet Another Ralph Runner
          </p>
          {appVersion && (
            <p className="text-sm text-muted-foreground">v{appVersion}</p>
          )}
        </div>
        <div className="flex gap-2 items-center pt-2">
          {updateDownloading ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 motion-safe:animate-spin" />
              Downloading...
            </span>
          ) : (
            updateAvailable && (
              <Button size="sm" onClick={installUpdate}>
                <Download className="size-4" />
                {updateAvailable.version}
              </Button>
            )
          )}
          <Button variant="secondary" onClick={() => navigate("/history")}>
            History
          </Button>
          {addMode === null && (
            <Button onClick={handleAddRepo}>+ Add repo</Button>
          )}
          {addMode === "choosing" && (
            <>
              <Button onClick={handleChooseLocal}>Local</Button>
              <Button onClick={handleChooseSsh}>SSH</Button>
              <Button variant="secondary" onClick={handleCancelAdd}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </header>

      {addMode === "ssh-form" && (
        <div className="bg-card border border-border rounded-md p-4 mb-6 flex flex-col gap-3">
          <Label>
            SSH Host
            <Input
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
            />
          </Label>
          <Label>
            Remote Path
            <Input
              value={sshRemotePath}
              onChange={(e) => setSshRemotePath(e.target.value)}
            />
          </Label>
          <div className="flex gap-2">
            <Button onClick={handleAddSshRepo}>Add</Button>
            <Button variant="secondary" onClick={handleCancelAdd}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {repos.length === 0 && oneShotEntries.size === 0 ? (
        <div className="text-center text-muted-foreground py-16">
          <p>No repos configured yet.</p>
          <p>Click &quot;Add repo&quot; to get started.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
            {activeItems.map((item) =>
              item.type === "repo" ? (
                <RepoCard
                  key={item.key}
                  repo={item.repo}
                  status={item.status}
                  lastTrace={latestTraces.get(item.repo.id)}
                  gitStatus={gitStatus[item.repo.id]}
                  planExcerpt={planPreviews.get(item.repo.id)}
                  planProgress={sessions.get(item.repo.id)?.planProgress}
                  onClick={() => navigate(`/repo/${item.repo.id}`)}
                  onPlanClick={openPlanPanel(item.repo.id)}
                  onRemove={() =>
                    handleRemoveRepo(item.repo.id, item.repo.name)
                  }
                />
              ) : (
                <OneShotCard
                  key={item.key}
                  entry={item.entry}
                  phase={item.phase}
                  onClick={() => navigate(`/oneshot/${item.entry.id}`)}
                />
              ),
            )}
          </div>

          {completedOneShots.length > 0 && (
            <Collapsible
              open={completedOpen}
              onOpenChange={setCompletedOpen}
              className="mt-8"
            >
              <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none group w-full">
                <span
                  className="transition-transform duration-150"
                  style={{
                    display: "inline-block",
                    transform: completedOpen ? "rotate(90deg)" : "rotate(0deg)",
                  }}
                >
                  &#x25B6;
                </span>
                <span className="uppercase tracking-wider font-medium">
                  Completed 1-Shots
                </span>
                <span className="text-muted-foreground/60">
                  ({completedOneShots.length})
                </span>
                <span className="flex-1 border-t border-border/50 ml-2" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-3 flex flex-col gap-px rounded-md border border-border overflow-hidden">
                  {completedOneShots.map((item) => {
                    const isFailed = item.entry.status === "failed";
                    return (
                      <button
                        key={item.key}
                        className="flex items-center gap-3 px-4 py-2.5 bg-card/50 hover:bg-accent/50 transition-colors text-left cursor-pointer group/row"
                        onClick={() => navigate(`/oneshot/${item.entry.id}`)}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{
                            background: isFailed
                              ? "var(--destructive)"
                              : "var(--success)",
                          }}
                        />
                        <span className="text-sm text-foreground/80 truncate min-w-0 flex-1">
                          {item.entry.title}
                        </span>
                        <span className="text-[10px] text-muted-foreground/60 truncate max-w-[120px] hidden sm:block">
                          {item.entry.parentRepoName}
                        </span>
                        <span
                          className="text-[10px] font-medium uppercase tracking-wider shrink-0 w-16 text-right"
                          style={{
                            color: isFailed
                              ? "var(--destructive)"
                              : "var(--success)",
                          }}
                        >
                          {phaseLabel(item.phase)}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 shrink-0 w-14 text-right">
                          {timeAgo(
                            new Date(item.entry.startedAt).toISOString(),
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}
        </>
      )}
      {planPanelContent && planPanelFile && (
        <PlanPanel
          open={planPanelOpen}
          onOpenChange={setPlanPanelOpen}
          planContent={planPanelContent}
          planFile={planPanelFile}
        />
      )}
    </main>
  );
}
