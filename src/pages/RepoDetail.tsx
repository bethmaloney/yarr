import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EventsList } from "@/components/EventsList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { toast } from "sonner";
import { sessionContextColor } from "../context-bar";
import { groupEventsByIteration, maxContextPercent } from "../iteration-groups";
import { parsePlanPreview, planDisplayName } from "../plan-preview";
import {
  Cpu,
  Repeat,
  ShieldCheck,
  GitBranch,
  Variable,
  Settings,
  FileText,
  Play,
  Square,
  Terminal,
  RefreshCw,
} from "lucide-react";
import type { Check, SessionState } from "../types";
import type { RepoConfig } from "../repos";
import { timeAgo } from "../time";

type ConnectionTestStep = {
  name: string;
  status: "pending" | "running" | "pass" | "fail";
  error?: string;
};
type ConnectionTest = { running: boolean; steps: ConnectionTestStep[] };

const defaultSession: SessionState = {
  running: false,
  events: [],
  trace: null,
  error: null,
};

export default function RepoDetail() {
  const { repoId } = useParams<{ repoId: string }>();
  const navigate = useNavigate();

  const repos = useAppStore((s) => s.repos);
  const sessions = useAppStore((s) => s.sessions);
  const runSession = useAppStore((s) => s.runSession);
  const stopSession = useAppStore((s) => s.stopSession);
  const reconnectSession = useAppStore((s) => s.reconnectSession);
  const updateRepo = useAppStore((s) => s.updateRepo);
  const runOneShot = useAppStore((s) => s.runOneShot);
  const gitStatusMap = useAppStore((s) => s.gitStatus);
  const fetchGitStatus = useAppStore((s) => s.fetchGitStatus);

  const repo = repos.find((r) => r.id === repoId);
  const session: SessionState =
    (repoId && sessions.get(repoId)) || defaultSession;

  // Local settings state
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [model, setModel] = useState("");
  const [maxIterations, setMaxIterations] = useState(0);
  const [completionSignal, setCompletionSignal] = useState("");
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [createBranch, setCreateBranch] = useState(true);
  const [autoFetch, setAutoFetch] = useState(true);
  const [plansDir, setPlansDir] = useState("");
  const [movePlansToCompleted, setMovePlansToCompleted] = useState(true);
  const [gitSyncEnabled, setGitSyncEnabled] = useState(false);
  const [gitSyncModel, setGitSyncModel] = useState("");
  const [gitSyncMaxRetries, setGitSyncMaxRetries] = useState(3);
  const [gitSyncPrompt, setGitSyncPrompt] = useState("");

  // Config sheet state
  const [configOpen, setConfigOpen] = useState(false);

  // Branch state (derived from store git status)
  const gitStatusEntry = repoId ? gitStatusMap[repoId] : undefined;
  const gitStatus = gitStatusEntry?.status ?? null;
  const [branches, setBranches] = useState<string[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [branchSearch, setBranchSearch] = useState("");

  // Plan state
  const [planFile, setPlanFile] = useState("");
  const [previewContent, setPreviewContent] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [plans, setPlans] = useState<string[]>([]);
  const [planDropdownOpen, setPlanDropdownOpen] = useState(false);
  const [planSearch, setPlanSearch] = useState("");
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState<string | null>(null);

  // Session plan preview state (distinct from plan-selector preview)
  const [sessionPlanParsed, setSessionPlanParsed] = useState<{
    name: string;
    excerpt: string;
  } | null>(null);

  // 1-shot form state
  const [oneShotOpen, setOneShotOpen] = useState(false);
  const [oneShotTitle, setOneShotTitle] = useState("");
  const [oneShotPrompt, setOneShotPrompt] = useState("");
  const [oneShotModel, setOneShotModel] = useState("");
  const [oneShotMergeStrategy, setOneShotMergeStrategy] =
    useState("merge_to_main");
  const [oneShotSubmitting, setOneShotSubmitting] = useState(false);

  // Connection test state
  const [connectionTest, setConnectionTest] = useState<ConnectionTest | null>(
    null,
  );

  const nameInputRef = useRef<HTMLInputElement>(null);
  const wasRunningRef = useRef(false);
  const connectionTestCleanupRef = useRef<(() => void) | null>(null);

  // Sync local state when repo changes
  useEffect(() => {
    if (!repo) return;
    setNameInput(repo.name);
    setEditingName(false);
    setModel(repo.model);
    setMaxIterations(repo.maxIterations);
    setCompletionSignal(repo.completionSignal);
    setEnvVars(
      Object.entries(repo.envVars ?? {}).map(([key, value]) => ({
        key,
        value,
      })),
    );
    setChecks(repo.checks ?? []);
    setCreateBranch(repo.createBranch ?? true);
    setAutoFetch(repo.autoFetch ?? (repo.type === "local" ? true : false));
    setPlansDir(repo.plansDir ?? "");
    setMovePlansToCompleted(repo.movePlansToCompleted ?? true);
    setGitSyncEnabled(repo.gitSync?.enabled ?? false);
    setGitSyncModel(repo.gitSync?.model ?? "");
    setGitSyncMaxRetries(repo.gitSync?.maxPushRetries ?? 3);
    setGitSyncPrompt(repo.gitSync?.conflictPrompt ?? "");
    setOneShotModel(repo.model);
  }, [repo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build repo payload for invoke calls
  function buildRepoPayload() {
    if (!repo) return null;
    return repo.type === "local"
      ? { type: "local" as const, path: repo.path }
      : {
          type: "ssh" as const,
          sshHost: (repo as Extract<RepoConfig, { type: "ssh" }>).sshHost,
          remotePath: (repo as Extract<RepoConfig, { type: "ssh" }>).remotePath,
        };
  }

  // Fetch git status on mount and when repo changes
  useEffect(() => {
    if (!repo || !repoId) return;
    fetchGitStatus(repoId, repo, true);
  }, [repo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh git status after session completes
  useEffect(() => {
    if (wasRunningRef.current && !session.running) {
      if (repo && repoId) {
        fetchGitStatus(repoId, repo, true);
      }

      // Clear plan selector after successful completion with a plan file.
      // Use session.events (not session.trace) because trace may not be set yet
      // when the event listener flips running=false — both events and running
      // are updated in the same store state update, avoiding a race condition.
      const completeEvent = session.events.findLast(
        (e) =>
          e.kind === "session_complete" &&
          e.outcome === "completed" &&
          e.plan_file,
      );
      if (completeEvent) {
        setPlanFile("");
      }
    }
    wasRunningRef.current = session.running;
  }, [session.running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plan file preview
  useEffect(() => {
    if (!planFile) {
      setPreviewContent("");
      setPreviewLoading(false);
      return;
    }
    const currentFile = planFile;
    setPreviewLoading(true);
    invoke("read_file_preview", { path: currentFile })
      .then((result) => {
        if (currentFile === planFile) {
          setPreviewContent(result as string);
          setPreviewLoading(false);
        }
      })
      .catch((e) => {
        console.warn("[RepoDetail] failed to load file preview:", e);
        if (currentFile === planFile) {
          setPreviewContent("");
          setPreviewLoading(false);
        }
      });
  }, [planFile]);

  // Session plan preview — load and parse preview from the session's plan file
  const sessionPlanFile = session.trace?.plan_file ?? null;
  useEffect(() => {
    if (!sessionPlanFile) {
      setSessionPlanParsed(null);
      return;
    }
    const currentPath = sessionPlanFile;

    function tryPath(path: string) {
      return invoke("read_file_preview", { path, maxLines: 8 }).then(
        (result) => result as string,
      );
    }

    // Build a fallback path with /completed/ inserted before the filename
    function completedVariant(path: string): string {
      const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      if (lastSep < 0) return "completed/" + path;
      return path.slice(0, lastSep) + "/completed" + path.slice(lastSep);
    }

    tryPath(currentPath)
      .catch(() => tryPath(completedVariant(currentPath)))
      .then((content) => {
        if (currentPath === sessionPlanFile) {
          setSessionPlanParsed(parsePlanPreview(content));
        }
      })
      .catch((e) => {
        console.warn("[RepoDetail] failed to load file preview:", e);
        if (currentPath === sessionPlanFile) {
          setSessionPlanParsed(null);
        }
      });
  }, [sessionPlanFile]);

  // Clean up connection test listeners on unmount
  useEffect(() => {
    return () => {
      connectionTestCleanupRef.current?.();
    };
  }, []);

  // Auto-focus name input when editing
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
    }
  }, [editingName]);

  const repoPath = useMemo(() => {
    if (!repo) return "";
    return repo.type === "local"
      ? repo.path
      : (repo as Extract<RepoConfig, { type: "ssh" }>).remotePath;
  }, [repo]);

  const repoDisplayPath = useMemo(() => {
    if (!repo) return "";
    if (repo.type === "local") return repo.path;
    const ssh = repo as Extract<RepoConfig, { type: "ssh" }>;
    return `${ssh.sshHost}:${ssh.remotePath}`;
  }, [repo]);

  const filteredBranches = useMemo(
    () =>
      branchSearch
        ? branches.filter((b) =>
            b.toLowerCase().includes(branchSearch.toLowerCase()),
          )
        : branches,
    [branches, branchSearch],
  );

  const filteredPlans = useMemo(
    () =>
      planSearch
        ? plans.filter((p) =>
            p.toLowerCase().includes(planSearch.toLowerCase()),
          )
        : plans,
    [plans, planSearch],
  );

  const selectedPlanName = useMemo(() => {
    if (!planFile) return "";
    const parts = planFile.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1];
  }, [planFile]);

  if (!repo) {
    return <div>Repo not found</div>;
  }

  function saveName() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== repo!.name) {
      updateRepo({ ...repo!, name: trimmed });
    }
    setEditingName(false);
  }

  function handleNameKeydown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      saveName();
    } else if (e.key === "Escape") {
      setNameInput(repo!.name);
      setEditingName(false);
    }
  }

  function saveSettings() {
    const envVarsRecord: Record<string, string> = {};
    for (const { key, value } of envVars) {
      if (key.trim()) envVarsRecord[key.trim()] = value;
    }
    updateRepo({
      ...repo!,
      model,
      maxIterations,
      completionSignal,
      envVars: envVarsRecord,
      checks,
      createBranch,
      autoFetch,
      movePlansToCompleted,
      plansDir: plansDir || undefined,
      gitSync: {
        enabled: gitSyncEnabled,
        model: gitSyncModel || undefined,
        maxPushRetries: gitSyncMaxRetries,
        conflictPrompt: gitSyncPrompt || undefined,
      },
    });
  }

  async function browsePrompt() {
    try {
      const result = await open({
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All", extensions: ["*"] },
        ],
        title: "Select prompt file",
      });
      if (result !== null) {
        setPlanFile(result as string);
      }
    } catch {
      // silently fail
    }
  }

  async function testConnection() {
    if (!repo || repo.type !== "ssh") return;
    const ssh = repo as Extract<RepoConfig, { type: "ssh" }>;
    const stepNames = [
      "SSH reachable",
      "tmux available",
      "claude available",
      "Remote path exists",
    ];
    const initialSteps: ConnectionTestStep[] = stepNames.map((name, i) => ({
      name,
      status: i === 0 ? ("running" as const) : ("pending" as const),
    }));
    setConnectionTest({ running: true, steps: initialSteps });

    const unlistenStep = await listen<{
      step: string;
      status: string;
      error?: string;
    }>("ssh-test-step", (e) => {
      const payload = e.payload;
      setConnectionTest((prev) => {
        if (!prev) return prev;
        const newSteps = prev.steps.map((s) => {
          if (s.name === payload.step) {
            return {
              ...s,
              status: payload.status as "pass" | "fail",
              error: payload.error ?? undefined,
            };
          }
          return s;
        });
        if (payload.status === "pass") {
          const nextPending = newSteps.findIndex((s) => s.status === "pending");
          if (nextPending !== -1) {
            newSteps[nextPending] = {
              ...newSteps[nextPending],
              status: "running",
            };
          }
        }
        return { ...prev, steps: newSteps };
      });
    });

    const unlistenComplete = await listen("ssh-test-complete", () => {
      setConnectionTest((prev) => (prev ? { ...prev, running: false } : null));
      unlistenStep();
      unlistenComplete();
      connectionTestCleanupRef.current = null;
    });

    connectionTestCleanupRef.current = () => {
      unlistenStep();
      unlistenComplete();
    };

    console.debug("[RepoDetail] invoking test_ssh_connection_steps", { sshHost: ssh.sshHost });
    invoke("test_ssh_connection_steps", {
      sshHost: ssh.sshHost,
      remotePath: ssh.remotePath,
    }).catch((e) => {
      console.warn("[RepoDetail] SSH connection test failed:", e);
      setConnectionTest((prev) => (prev ? { ...prev, running: false } : null));
      unlistenStep();
      unlistenComplete();
    });
  }

  async function fetchBranches() {
    const payload = buildRepoPayload();
    if (!payload) return;
    console.debug("[RepoDetail] invoking list_local_branches");
    try {
      const result = await invoke<string[]>("list_local_branches", {
        repo: payload,
      });
      setBranches(result);
    } catch (e) {
      console.warn("[RepoDetail] failed to list branches:", e);
      setBranches([]);
    }
  }

  async function handleFastForward() {
    const payload = buildRepoPayload();
    if (!payload) return;
    try {
      await invoke("fast_forward_branch", { repo: payload });
      setBranchDropdownOpen(false);
      setBranchSearch("");
      if (repoId && repo) fetchGitStatus(repoId, repo, true);
      toast.success("Branch fast-forwarded");
    } catch (e) {
      console.error("Failed to fast-forward:", e);
      toast.error(`Failed to fast-forward: ${e}`);
    }
  }

  async function handleSwitchBranch(branchName: string) {
    const payload = buildRepoPayload();
    if (!payload) return;
    try {
      await invoke("switch_branch", { repo: payload, branch: branchName });
      setBranchDropdownOpen(false);
      setBranchSearch("");
      if (repoId && repo) fetchGitStatus(repoId, repo, true);
      toast.success(`Switched to ${branchName}`);
    } catch (e) {
      console.error("Failed to switch branch:", e);
      toast.error(`Failed to switch branch: ${e}`);
    }
  }

  async function handleOneShotSubmit() {
    if (!repoId || !oneShotTitle.trim() || !oneShotPrompt.trim()) return;
    setOneShotSubmitting(true);
    try {
      const oneshotId = await runOneShot(
        repoId,
        oneShotTitle.trim(),
        oneShotPrompt.trim(),
        oneShotModel,
        oneShotMergeStrategy,
      );
      if (oneshotId) {
        navigate(`/oneshot/${oneshotId}`);
      }
    } finally {
      setOneShotSubmitting(false);
    }
  }

  async function fetchPlans() {
    const payload = buildRepoPayload();
    if (!payload) {
      console.warn("[fetchPlans] buildRepoPayload returned null, aborting");
      return;
    }
    const plansDir = (repo!.plansDir || "docs/plans/").replace(/\/?$/, "/");
    console.info("[fetchPlans] requesting list_plans", { plansDir, payload });
    setPlansLoading(true);
    setPlansError(null);
    try {
      const result = await invoke<string[]>("list_plans", {
        repo: payload,
        plansDir,
      });
      console.info("[fetchPlans] received plans", {
        count: result.length,
        plans: result,
      });
      setPlans(result);
    } catch (e) {
      console.error("[fetchPlans] list_plans failed", e);
      setPlans([]);
      const msg = typeof e === "string" ? e : String(e);
      setPlansError(msg);
      toast.error(msg);
    } finally {
      console.info("[fetchPlans] done, setting plansLoading=false");
      setPlansLoading(false);
    }
  }

  function handleSelectPlan(filename: string) {
    const dir = (repo!.plansDir || "docs/plans/").replace(/\/?$/, "/");
    setPlanFile(`${dir}${filename}`);
    setPlanDropdownOpen(false);
    setPlanSearch("");
  }

  // Context percentage computation — peak across all iterations
  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(session.events)),
    [session.events],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

  return (
    <main className="max-w-[900px] mx-auto p-8">
      <Breadcrumbs
        crumbs={[
          { label: "Home", onClick: () => navigate("/") },
          { label: repo.name },
        ]}
      />

      <header className="mb-6">
        {editingName ? (
          <h1 className="text-3xl text-primary font-bold">
            <input
              ref={nameInputRef}
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={saveName}
              onKeyDown={handleNameKeydown}
              className="bg-transparent border-b border-primary outline-none text-3xl text-primary font-bold w-full"
            />
          </h1>
        ) : (
          <h1
            className="text-3xl text-primary font-bold cursor-pointer hover:opacity-80"
            onClick={() => setEditingName(true)}
          >
            {repo.name}
          </h1>
        )}
        <p className="text-sm text-muted-foreground mt-1">{repoDisplayPath}</p>
      </header>

      {/* Branch selector + git status */}
      {(gitStatus || gitStatusEntry?.error) && (
        <div className="flex items-center gap-2 mb-6">
          {gitStatus && (
            <>
              {session.running ? (
                <button
                  className={`branch-chip inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-secondary text-secondary-foreground${gitStatus.behind && gitStatus.behind > 0 ? " warning border border-warning" : ""}`}
                  disabled
                >
                  {gitStatus.branchName}
                  {gitStatus.dirtyCount != null && gitStatus.dirtyCount > 0 && (
                    <span className="text-xs opacity-70">
                      {gitStatus.dirtyCount} dirty
                    </span>
                  )}
                  {gitStatus.ahead != null && gitStatus.ahead > 0 && (
                    <span className="text-xs opacity-70">
                      {"\u2191"}
                      {gitStatus.ahead}
                    </span>
                  )}
                  {gitStatus.behind != null && gitStatus.behind > 0 && (
                    <span className="text-xs opacity-70">
                      {"\u2193"}
                      {gitStatus.behind}
                    </span>
                  )}
                </button>
              ) : (
                <Popover
                  open={branchDropdownOpen}
                  onOpenChange={setBranchDropdownOpen}
                >
                  <PopoverTrigger asChild>
                    <button
                      className={`branch-chip inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-secondary text-secondary-foreground hover:bg-secondary/80 cursor-pointer${gitStatus.behind && gitStatus.behind > 0 ? " warning border border-warning" : ""}`}
                      onClick={() => {
                        if (!branchDropdownOpen) fetchBranches();
                      }}
                    >
                      {gitStatus.branchName}
                      {gitStatus.dirtyCount != null &&
                        gitStatus.dirtyCount > 0 && (
                          <span className="text-xs opacity-70">
                            {gitStatus.dirtyCount} dirty
                          </span>
                        )}
                      {gitStatus.ahead != null && gitStatus.ahead > 0 && (
                        <span className="text-xs opacity-70">
                          {"\u2191"}
                          {gitStatus.ahead}
                        </span>
                      )}
                      {gitStatus.behind != null && gitStatus.behind > 0 && (
                        <span className="text-xs opacity-70">
                          {"\u2193"}
                          {gitStatus.behind}
                        </span>
                      )}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="branch-dropdown w-64 p-0"
                    onEscapeKeyDown={() => {
                      setBranchSearch("");
                    }}
                  >
                    {gitStatus.behind != null && gitStatus.behind > 0 && (
                      <div className="p-2 border-b border-border">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="w-full"
                          onClick={handleFastForward}
                        >
                          Fast-forward
                        </Button>
                      </div>
                    )}
                    <Command shouldFilter={false}>
                      <CommandInput
                        className="branch-search"
                        placeholder="Search branches..."
                        value={branchSearch}
                        onValueChange={setBranchSearch}
                      />
                      <CommandList>
                        <CommandEmpty className="branch-empty">
                          No matching branches
                        </CommandEmpty>
                        {filteredBranches.map((branch) => (
                          <CommandItem
                            key={branch}
                            value={branch}
                            className={`branch-item${branch === gitStatus?.branchName ? " active font-bold" : ""}`}
                            onSelect={() => handleSwitchBranch(branch)}
                          >
                            {branch}
                          </CommandItem>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}
            </>
          )}

          {/* Error indicator - shown when error and no status */}
          {gitStatusEntry?.error && !gitStatus && (
            <span
              className="text-xs text-yellow-500"
              title={gitStatusEntry.error}
            >
              {"\u26A0"}
            </span>
          )}

          {/* Refresh button */}
          <button
            aria-label="Refresh git status"
            className="inline-flex items-center justify-center size-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            onClick={() => {
              if (repoId && repo) fetchGitStatus(repoId, repo, true);
            }}
            disabled={gitStatusEntry?.loading}
          >
            <RefreshCw
              className={`size-3.5 ${gitStatusEntry?.loading ? "animate-spin" : ""}`}
            />
          </button>

          {/* Last checked timestamp */}
          {gitStatusEntry?.lastChecked && (
            <span className="text-xs text-muted-foreground">
              last checked: {timeAgo(gitStatusEntry.lastChecked.toISOString())}
            </span>
          )}
        </div>
      )}

      {/* Inline config bar */}
      <div
        className="settings flex flex-wrap items-center gap-2 mb-6 px-3 py-2 rounded-md bg-card border border-border hover:border-primary/30 transition-colors cursor-pointer group"
        onClick={() => setConfigOpen(true)}
      >
        <Badge variant="secondary" className="font-mono">
          <Cpu className="size-3" />
          {model}
        </Badge>
        <Badge variant="secondary">
          <Repeat className="size-3" />
          {maxIterations} iters
        </Badge>
        <Badge variant="secondary">
          <ShieldCheck className="size-3" />
          {checks.length} checks
        </Badge>
        <Badge variant={gitSyncEnabled ? "success" : "outline"}>
          <GitBranch className="size-3" />
          git sync {gitSyncEnabled ? "on" : "off"}
        </Badge>
        {envVars.length > 0 && (
          <Badge variant="secondary">
            <Variable className="size-3" />
            {envVars.length} env
          </Badge>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto opacity-50 group-hover:opacity-100 transition-opacity"
          aria-label="Configure"
          onClick={(e) => {
            e.stopPropagation();
            setConfigOpen(true);
          }}
        >
          <Settings />
        </Button>
      </div>

      {/* Config Sheet */}
      <Sheet open={configOpen} onOpenChange={setConfigOpen}>
        <SheetContent
          side="right"
          className="overflow-y-auto border-l border-border bg-card"
        >
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Settings className="size-4 text-primary" />
              Configuration
            </SheetTitle>
            <SheetDescription>
              Settings, checks, and git sync for {repo.name}
            </SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="settings" className="px-4">
            <TabsList className="w-full">
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="checks">Checks</TabsTrigger>
              <TabsTrigger value="git-sync">Git Sync</TabsTrigger>
            </TabsList>

            {/* ── Settings tab ── */}
            <TabsContent value="settings">
              <div className="flex flex-col gap-4 pt-4">
                {repo.type === "ssh" && (
                  <>
                    <Label className="flex flex-col gap-1">
                      SSH Host
                      <Input
                        type="text"
                        value={
                          (repo as Extract<RepoConfig, { type: "ssh" }>).sshHost
                        }
                        readOnly
                        disabled
                      />
                    </Label>
                    <Label className="flex flex-col gap-1">
                      Remote Path
                      <Input
                        type="text"
                        value={
                          (repo as Extract<RepoConfig, { type: "ssh" }>)
                            .remotePath
                        }
                        readOnly
                        disabled
                      />
                    </Label>
                  </>
                )}
                <Label className="flex flex-col gap-1">
                  Model
                  <Input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={session.running}
                    className="font-mono"
                  />
                </Label>
                <Label className="flex flex-col gap-1">
                  Max Iterations
                  <Input
                    type="number"
                    value={maxIterations}
                    onChange={(e) => setMaxIterations(Number(e.target.value))}
                    min={1}
                    disabled={session.running}
                    className="font-mono"
                  />
                </Label>
                <Label className="flex flex-col gap-1">
                  Completion Signal
                  <Input
                    type="text"
                    value={completionSignal}
                    onChange={(e) => setCompletionSignal(e.target.value)}
                    disabled={session.running}
                    className="font-mono"
                  />
                </Label>
                <Label className="flex flex-col gap-1">
                  Plans Directory
                  <Input
                    type="text"
                    value={plansDir}
                    onChange={(e) => setPlansDir(e.target.value)}
                    placeholder="docs/plans/"
                    disabled={session.running}
                  />
                </Label>
                <Label
                  htmlFor="create-branch"
                  className="flex items-center gap-2 text-sm font-normal"
                >
                  <Checkbox
                    id="create-branch"
                    checked={createBranch}
                    onCheckedChange={(v) => setCreateBranch(v === true)}
                    disabled={session.running}
                  />
                  Create branch on run
                </Label>
                <Label
                  htmlFor="auto-fetch"
                  className="flex items-center gap-2 text-sm font-normal"
                >
                  <Checkbox
                    id="auto-fetch"
                    checked={autoFetch}
                    onCheckedChange={(v) => setAutoFetch(v === true)}
                    disabled={session.running}
                  />
                  Auto-fetch from remote
                  <span className="text-xs text-muted-foreground font-normal">
                    Automatically fetch from remote every 30 seconds
                  </span>
                </Label>
                <Label
                  htmlFor="move-plans-completed"
                  className="flex items-center gap-2 text-sm font-normal"
                >
                  <Checkbox
                    id="move-plans-completed"
                    checked={movePlansToCompleted}
                    onCheckedChange={(v) => setMovePlansToCompleted(v === true)}
                    disabled={session.running}
                  />
                  Move plans to completed folder after run
                </Label>
                <fieldset
                  disabled={session.running}
                  className="flex flex-col gap-3"
                >
                  <legend className="text-sm font-medium mb-2">
                    Environment Variables
                  </legend>
                  {envVars.map((envVar, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        type="text"
                        value={envVar.key}
                        onChange={(e) => {
                          const updated = [...envVars];
                          updated[i] = { ...updated[i], key: e.target.value };
                          setEnvVars(updated);
                        }}
                        placeholder="KEY"
                        className="flex-1"
                      />
                      <span className="text-muted-foreground">=</span>
                      <Input
                        type="text"
                        value={envVar.value}
                        onChange={(e) => {
                          const updated = [...envVars];
                          updated[i] = { ...updated[i], value: e.target.value };
                          setEnvVars(updated);
                        }}
                        placeholder="value"
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setEnvVars(envVars.filter((_, j) => j !== i))
                        }
                      >
                        &times;
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setEnvVars([...envVars, { key: "", value: "" }])
                    }
                  >
                    + Add Variable
                  </Button>
                </fieldset>
                {connectionTest && (
                  <div
                    data-testid="connection-checklist"
                    className="flex flex-col gap-2 mt-2"
                  >
                    {connectionTest.steps.map((step) => (
                      <div
                        key={step.name}
                        className={`step-${step.status} flex items-center gap-2 text-sm`}
                      >
                        <span
                          className={
                            step.status === "pass"
                              ? "text-success"
                              : step.status === "fail"
                                ? "text-destructive"
                                : "text-muted-foreground"
                          }
                        >
                          {step.status === "running"
                            ? "..."
                            : step.status === "pass"
                              ? "\u2713"
                              : step.status === "fail"
                                ? "\u2717"
                                : "\u00B7"}
                        </span>
                        <span>{step.name}</span>
                        {step.error && (
                          <span className="text-destructive text-xs">
                            {step.error}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ── Checks tab ── */}
            <TabsContent value="checks">
              <div className="flex flex-col gap-4 pt-4">
                <Accordion type="multiple">
                  {checks.map((check, i) => (
                    <AccordionItem
                      key={i}
                      value={`check-${i}`}
                      className="check-entry"
                    >
                      <div className="flex items-center">
                        <AccordionTrigger className="flex-1">
                          {check.name || "New Check"}
                        </AccordionTrigger>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={session.running}
                          onClick={() => {
                            setChecks(checks.filter((_, j) => j !== i));
                          }}
                        >
                          &times;
                        </Button>
                      </div>
                      <AccordionContent>
                        <div className="flex flex-col gap-3 pt-2">
                          <Label className="flex flex-col gap-1">
                            Name
                            <Input
                              type="text"
                              value={check.name}
                              onChange={(e) => {
                                const updated = [...checks];
                                updated[i] = {
                                  ...updated[i],
                                  name: e.target.value,
                                };
                                setChecks(updated);
                              }}
                              disabled={session.running}
                            />
                          </Label>
                          <Label className="flex flex-col gap-1">
                            Command
                            <Input
                              type="text"
                              value={check.command}
                              onChange={(e) => {
                                const updated = [...checks];
                                updated[i] = {
                                  ...updated[i],
                                  command: e.target.value,
                                };
                                setChecks(updated);
                              }}
                              disabled={session.running}
                            />
                          </Label>
                          <Label className="flex flex-col gap-1">
                            When
                            <Select
                              value={check.when}
                              onValueChange={(value) => {
                                const updated = [...checks];
                                updated[i] = {
                                  ...updated[i],
                                  when: value as Check["when"],
                                };
                                setChecks(updated);
                              }}
                              disabled={session.running}
                            >
                              <SelectTrigger className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="each_iteration">
                                  each_iteration
                                </SelectItem>
                                <SelectItem value="post_completion">
                                  post_completion
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          </Label>
                          <div className="grid grid-cols-2 gap-3">
                            <Label className="flex flex-col gap-1">
                              Timeout
                              <Input
                                type="number"
                                value={check.timeoutSecs}
                                onChange={(e) => {
                                  const updated = [...checks];
                                  updated[i] = {
                                    ...updated[i],
                                    timeoutSecs: Number(e.target.value),
                                  };
                                  setChecks(updated);
                                }}
                                min={1}
                                disabled={session.running}
                              />
                            </Label>
                            <Label className="flex flex-col gap-1">
                              Retries
                              <Input
                                type="number"
                                value={check.maxRetries}
                                onChange={(e) => {
                                  const updated = [...checks];
                                  updated[i] = {
                                    ...updated[i],
                                    maxRetries: Number(e.target.value),
                                  };
                                  setChecks(updated);
                                }}
                                min={0}
                                disabled={session.running}
                              />
                            </Label>
                          </div>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={session.running}
                  onClick={() =>
                    setChecks([
                      ...checks,
                      {
                        name: "",
                        command: "",
                        when: "each_iteration",
                        timeoutSecs: 300,
                        maxRetries: 1,
                      },
                    ])
                  }
                >
                  Add Check
                </Button>
              </div>
            </TabsContent>

            {/* ── Git Sync tab ── */}
            <TabsContent value="git-sync">
              <div className="flex flex-col gap-4 pt-4">
                <Label
                  htmlFor="git-sync-enabled"
                  className="flex items-center gap-2 text-sm font-normal"
                >
                  <Checkbox
                    id="git-sync-enabled"
                    checked={gitSyncEnabled}
                    onCheckedChange={(v) => setGitSyncEnabled(v === true)}
                    disabled={session.running}
                  />
                  Enable git sync
                </Label>
                <div className="flex flex-col gap-3">
                  <Label className="flex flex-col gap-1">
                    Model
                    <Input
                      type="text"
                      value={gitSyncModel}
                      onChange={(e) => setGitSyncModel(e.target.value)}
                      placeholder="sonnet"
                      disabled={session.running || !gitSyncEnabled}
                      className="font-mono"
                    />
                  </Label>
                  <Label className="flex flex-col gap-1">
                    Max Push Retries
                    <Input
                      type="number"
                      value={gitSyncMaxRetries}
                      onChange={(e) =>
                        setGitSyncMaxRetries(Number(e.target.value))
                      }
                      min={1}
                      disabled={session.running || !gitSyncEnabled}
                    />
                  </Label>
                  <Label className="flex flex-col gap-1">
                    Conflict Resolution Prompt
                    <Textarea
                      value={gitSyncPrompt}
                      onChange={(e) => setGitSyncPrompt(e.target.value)}
                      placeholder="Resolve merge conflicts..."
                      disabled={session.running || !gitSyncEnabled}
                      rows={3}
                    />
                  </Label>
                </div>
              </div>
            </TabsContent>
          </Tabs>
          <SheetFooter className="sticky bottom-0 bg-card border-t border-border">
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => {
                  saveSettings();
                  setConfigOpen(false);
                }}
                disabled={session.running}
              >
                Save
              </Button>
              {repo.type === "ssh" && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={testConnection}
                  disabled={connectionTest?.running}
                >
                  Test Connection
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setConfigOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Plan + Action section */}
      <section className="plan-section bg-card border border-border rounded-md p-4 mb-4">
        <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
          <FileText className="size-4 text-primary" />
          Plan
        </h2>
        <div className="flex gap-2 mt-1">
          <Popover open={planDropdownOpen} onOpenChange={setPlanDropdownOpen}>
            <PopoverTrigger asChild>
              <button
                className="flex-1 inline-flex items-center px-3 py-2 rounded-md border border-input bg-transparent text-sm text-left hover:bg-accent/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={session.running || plansLoading}
                aria-label="Select a plan"
                onClick={() => {
                  if (!planDropdownOpen) fetchPlans();
                }}
              >
                {selectedPlanName || "Select..."}
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-80 p-0"
              onEscapeKeyDown={() => setPlanSearch("")}
            >
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search plans..."
                  value={planSearch}
                  onValueChange={setPlanSearch}
                />
                <CommandList>
                  <CommandEmpty>
                    {plansError ? "Failed to load plans" : "No plans found"}
                  </CommandEmpty>
                  {plansLoading ? (
                    <CommandItem disabled value="loading">
                      Loading...
                    </CommandItem>
                  ) : (
                    filteredPlans.map((plan) => (
                      <CommandItem
                        key={plan}
                        value={plan}
                        className={plan === selectedPlanName ? "font-bold" : ""}
                        onSelect={() => handleSelectPlan(plan)}
                      >
                        {plan}
                      </CommandItem>
                    ))
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="secondary"
            onClick={browsePrompt}
            disabled={session.running}
          >
            Browse
          </Button>
        </div>
        <Input
          type="text"
          value={planFile}
          onChange={(e) => setPlanFile(e.target.value)}
          placeholder="docs/plans/my-feature-design.md"
          disabled={session.running}
          className="mt-2"
        />
        {previewLoading && (
          <p className="text-sm text-muted-foreground mt-2">Loading...</p>
        )}
        {!previewLoading && previewContent && (
          <pre className="mt-3 p-3 bg-card border border-border rounded-md text-xs text-foreground overflow-x-auto max-h-48 overflow-y-auto">
            {previewContent}
          </pre>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2 mt-4 pt-4 border-t border-border">
          {session.disconnected ? (
            <Button
              type="button"
              onClick={() => repoId && reconnectSession(repoId)}
            >
              Reconnect
            </Button>
          ) : session.reconnecting ? (
            <Button type="button" disabled>
              Reconnecting...
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="lg"
                disabled={session.running || !planFile}
                onClick={() => repoId && runSession(repoId, planFile)}
              >
                <Play className="size-4" />
                {session.running ? "Running..." : "Run"}
              </Button>
              {session.running && (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => repoId && stopSession(repoId)}
                >
                  <Square className="size-4" />
                  Stop
                </Button>
              )}
              <Button
                type="button"
                size="lg"
                variant="secondary"
                onClick={() => setOneShotOpen(!oneShotOpen)}
                disabled={session.running}
              >
                1-Shot
              </Button>
              {!planFile && !session.running && (
                <span className="text-muted-foreground text-xs ml-2">
                  Select a prompt file to start a run
                </span>
              )}
            </>
          )}
        </div>
        {oneShotOpen && !session.running && (
          <div className="mt-4 pt-4 border-t border-border flex flex-col gap-3">
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
                value={oneShotTitle}
                onChange={(e) => setOneShotTitle(e.target.value)}
                disabled={oneShotSubmitting}
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
                value={oneShotPrompt}
                onChange={(e) => setOneShotPrompt(e.target.value)}
                disabled={oneShotSubmitting}
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
                value={oneShotModel}
                onChange={(e) => setOneShotModel(e.target.value)}
                disabled={oneShotSubmitting}
                className="font-mono"
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
                    name="oneShotMergeStrategy"
                    value="merge_to_main"
                    checked={oneShotMergeStrategy === "merge_to_main"}
                    onChange={(e) => setOneShotMergeStrategy(e.target.value)}
                    disabled={oneShotSubmitting}
                  />
                  Merge to main
                </label>
                <label className="flex flex-row items-center gap-2 cursor-pointer text-foreground text-sm">
                  <input
                    type="radio"
                    name="oneShotMergeStrategy"
                    value="branch"
                    checked={oneShotMergeStrategy === "branch"}
                    onChange={(e) => setOneShotMergeStrategy(e.target.value)}
                    disabled={oneShotSubmitting}
                  />
                  Create branch
                </label>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                disabled={
                  oneShotSubmitting ||
                  !oneShotTitle.trim() ||
                  !oneShotPrompt.trim()
                }
                onClick={handleOneShotSubmit}
              >
                Launch
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOneShotOpen(false)}
                disabled={oneShotSubmitting}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Session plan preview banner */}
      {(() => {
        const showSessionPlanBanner =
          sessionPlanFile &&
          !planFile &&
          (session.running || session.trace) &&
          sessionPlanParsed;
        if (!showSessionPlanBanner) return null;
        return (
          <div className="bg-muted/50 border border-border rounded-md p-3 mb-4">
            <p className="text-sm font-semibold">
              {planDisplayName(sessionPlanFile, sessionPlanParsed.name)}
            </p>
            {sessionPlanParsed.excerpt && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {sessionPlanParsed.excerpt}
              </p>
            )}
          </div>
        );
      })()}

      {/* Disconnected banner */}
      {session.disconnected && (
        <section className="bg-destructive/10 border border-destructive/30 rounded-md p-4 mb-4">
          <p className="text-destructive font-medium">
            {session.disconnectReason
              ? `Connection lost: ${session.disconnectReason}`
              : "Connection lost"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            The remote session may still be running.
          </p>
        </section>
      )}

      {/* Events list or empty state */}
      {session.events.length === 0 &&
      !session.running &&
      !session.error &&
      !session.trace ? (
        <div className="flex flex-col items-center justify-center py-16 rounded-md border border-dashed border-border text-center">
          <Terminal className="size-8 text-muted-foreground mb-3" />
          <p className="text-sm font-medium">No sessions yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Select a prompt file and hit Run to start a session
          </p>
        </div>
      ) : (
        <EventsList
          events={session.events}
          isLive={session.running}
          repoPath={repoPath}
        />
      )}

      {/* Error section */}
      {session.error && (
        <section className="bg-destructive/10 border border-destructive/30 rounded-md p-4 mt-4">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <pre className="text-sm text-destructive whitespace-pre-wrap">
            {session.error}
          </pre>
        </section>
      )}

      {/* Trace/Result section */}
      {session.trace && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold mb-3">Result</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Outcome</dt>
            <dd>{session.trace.outcome}</dd>
            {session.trace.failure_reason && (
              <>
                <dt className="text-muted-foreground">Reason</dt>
                <dd className="text-destructive">
                  {session.trace.failure_reason}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Iterations</dt>
            <dd>{session.trace.total_iterations}</dd>
            <dt className="text-muted-foreground">Total Cost</dt>
            <dd>${session.trace.total_cost_usd.toFixed(4)}</dd>
            {ctxPercent !== null && (
              <>
                <dt className="text-muted-foreground">Peak Context</dt>
                <dd>
                  <span style={{ color: sessionContextColor(ctxPercent) }}>
                    {ctxPercent}%
                  </span>
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Session ID</dt>
            <dd className="font-mono text-xs">{session.trace.session_id}</dd>
          </dl>
        </section>
      )}
    </main>
  );
}
