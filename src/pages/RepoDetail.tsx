import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EventsList } from "@/components/EventsList";
import { Button } from "@/components/ui/button";
import { Input, NumberInput } from "@/components/ui/input";
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
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
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
import HistoryTable from "@/components/HistoryTable";
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
  Loader2,
  ChevronDown,
  Check as CheckIcon,
  X,
  XCircle,
  Plus,
  FileDown,
  ChevronRight,
} from "lucide-react";
import type { Check, SessionState, SessionTrace } from "../types";
import { repoPayload, type RepoConfig } from "../repos";
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
  const [designPromptFile, setDesignPromptFile] = useState("");
  const [implementationPromptFile, setImplementationPromptFile] = useState("");

  // Config sheet state
  const [configOpen, setConfigOpen] = useState(false);

  // Branch state (derived from store git status)
  const gitStatusEntry = repoId ? gitStatusMap[repoId] : undefined;
  const gitStatus = gitStatusEntry?.status ?? null;
  const [branches, setBranches] = useState<string[]>([]);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const [fastForwarding, setFastForwarding] = useState(false);
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

  const [effortLevel, setEffortLevel] = useState("medium");

  // 1-shot form state
  const [oneShotOpen, setOneShotOpen] = useState(false);
  const [oneShotTitle, setOneShotTitle] = useState("");
  const [oneShotPrompt, setOneShotPrompt] = useState("");
  const [oneShotModel, setOneShotModel] = useState("");
  const [oneShotMergeStrategy, setOneShotMergeStrategy] =
    useState("merge_to_main");
  const [oneShotEffortLevel, setOneShotEffortLevel] = useState("medium");
  const [oneShotDesignEffortLevel, setOneShotDesignEffortLevel] =
    useState("high");
  const [oneShotSubmitting, setOneShotSubmitting] = useState(false);

  // History tab state
  const [historyTraces, setHistoryTraces] = useState<SessionTrace[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyLoadedRef = useRef(false);

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
    setEffortLevel(repo.effortLevel ?? "medium");
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
    setDesignPromptFile(repo.designPromptFile ?? "");
    setImplementationPromptFile(repo.implementationPromptFile ?? "");
    setOneShotModel(repo.model);
    setOneShotDesignEffortLevel(repo.designEffortLevel ?? "high");
    setOneShotEffortLevel(repo.effortLevel ?? "medium");
  }, [repo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build repo payload for invoke calls
  function buildRepoPayload() {
    if (!repo) return null;
    return repoPayload(repo);
  }

  // Fetch git status on mount and when repo changes
  useEffect(() => {
    if (!repo || !repoId) return;
    fetchGitStatus(repoId, repo, true);
  }, [repo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch history traces for the History tab
  function fetchHistory() {
    if (!repoId) return;
    setHistoryLoading(true);
    setHistoryError(null);
    invoke<SessionTrace[]>("list_traces", { repoId })
      .then((result) => {
        setHistoryTraces(result);
        historyLoadedRef.current = true;
      })
      .catch((e) => setHistoryError(String(e)))
      .finally(() => setHistoryLoading(false));
  }

  // Refresh git status after session completes
  useEffect(() => {
    if (wasRunningRef.current && !session.running) {
      if (repo && repoId) {
        fetchGitStatus(repoId, repo, true);
      }

      // Refresh history if it was previously loaded
      if (historyLoadedRef.current) {
        fetchHistory();
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
    const payload = buildRepoPayload();
    if (!payload) return;
    setPreviewLoading(true);
    invoke("read_file_preview", { repo: payload, path: currentFile })
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
    const payload = buildRepoPayload();
    if (!payload) return;

    function tryPath(path: string) {
      return invoke("read_file_preview", { repo: payload, path, maxLines: 8 }).then(
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

  // Context percentage computation — peak across all iterations
  const ctxPeak = useMemo(
    () => maxContextPercent(groupEventsByIteration(session.events)),
    [session.events],
  );
  const ctxPercent = ctxPeak > 0 ? ctxPeak : null;

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
      effortLevel,
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
      designPromptFile: designPromptFile || undefined,
      implementationPromptFile: implementationPromptFile || undefined,
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

    console.debug("[RepoDetail] invoking test_ssh_connection_steps", {
      sshHost: ssh.sshHost,
    });
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
    setFastForwarding(true);
    try {
      await invoke("fast_forward_branch", { repo: payload });
      if (repoId && repo) await fetchGitStatus(repoId, repo, false);
      setBranchDropdownOpen(false);
      setBranchSearch("");
      toast.success("Branch fast-forwarded");
    } catch (e) {
      console.error("Failed to fast-forward:", e);
      toast.error(`Failed to fast-forward: ${e}`);
    } finally {
      setFastForwarding(false);
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
        oneShotEffortLevel,
        oneShotDesignEffortLevel,
      );
      if (oneshotId) {
        navigate(`/oneshot/${oneshotId}`);
      } else {
        toast.error("Failed to launch 1-shot");
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
        <div className="flex items-center gap-1.5 mb-6">
          {gitStatus && (
            <>
              {session.running ? (
                <button
                  className={`branch-chip inline-flex items-center gap-1.5 pl-2.5 pr-3 py-1 rounded-full text-sm font-mono border transition-colors bg-secondary text-secondary-foreground${gitStatus.behind && gitStatus.behind > 0 ? " warning border-warning" : " border-border"}`}
                  disabled
                >
                  <GitBranch className="size-3.5 opacity-60" />
                  {gitStatus.branchName}
                  {gitStatus.dirtyCount != null && gitStatus.dirtyCount > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
                      {gitStatus.dirtyCount} dirty
                    </span>
                  )}
                  {gitStatus.ahead != null && gitStatus.ahead > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                      {"\u2191"}
                      {gitStatus.ahead}
                    </span>
                  )}
                  {gitStatus.behind != null && gitStatus.behind > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
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
                      className={`branch-chip inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-full text-sm font-mono border transition-colors cursor-pointer bg-secondary text-secondary-foreground hover:bg-secondary/80 hover:border-foreground/20${branchDropdownOpen ? " ring-2 ring-ring/30 border-foreground/20" : ""}${gitStatus.behind && gitStatus.behind > 0 ? " warning border-warning" : " border-border"}`}
                      onClick={() => {
                        if (!branchDropdownOpen) fetchBranches();
                      }}
                    >
                      <GitBranch className="size-3.5 opacity-60" />
                      {gitStatus.branchName}
                      {gitStatus.dirtyCount != null &&
                        gitStatus.dirtyCount > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
                            {gitStatus.dirtyCount} dirty
                          </span>
                        )}
                      {gitStatus.ahead != null && gitStatus.ahead > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-success/15 text-success">
                          {"\u2191"}
                          {gitStatus.ahead}
                        </span>
                      )}
                      {gitStatus.behind != null && gitStatus.behind > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-warning/15 text-warning">
                          {"\u2193"}
                          {gitStatus.behind}
                        </span>
                      )}
                      <ChevronDown
                        className={`size-3.5 opacity-50 transition-transform ${branchDropdownOpen ? "rotate-180" : ""}`}
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="branch-dropdown w-64 p-0"
                    onEscapeKeyDown={() => {
                      setBranchSearch("");
                    }}
                  >
                    {gitStatus.behind != null && gitStatus.behind > 0 && (
                      <div className="p-2 border-b border-warning/30 bg-warning/5">
                        <Button
                          type="button"
                          variant="default"
                          size="sm"
                          className="w-full bg-warning text-warning-foreground hover:bg-warning/90"
                          onClick={handleFastForward}
                          disabled={fastForwarding}
                        >
                          {fastForwarding ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              Fast-forwarding…
                            </>
                          ) : (
                            <>
                              {"\u2193"}
                              {gitStatus.behind} behind — Fast-forward
                            </>
                          )}
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
                            className={`branch-item${branch === gitStatus?.branchName ? " active" : ""}`}
                            onSelect={() => handleSwitchBranch(branch)}
                          >
                            <span className="flex items-center gap-2 w-full font-mono text-sm">
                              {branch === gitStatus?.branchName ? (
                                <CheckIcon className="size-3.5 text-success shrink-0" />
                              ) : (
                                <span className="size-3.5 shrink-0" />
                              )}
                              <span className="truncate">{branch}</span>
                            </span>
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
            <span className="text-xs text-warning" title={gitStatusEntry.error}>
              {"\u26A0"}
            </span>
          )}

          {/* Refresh button — timestamp shown in title tooltip */}
          <button
            aria-label="Refresh git status"
            title={
              gitStatusEntry?.lastChecked
                ? `Last checked: ${timeAgo(gitStatusEntry.lastChecked.toISOString())}`
                : undefined
            }
            className="inline-flex items-center justify-center size-7 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
            onClick={() => {
              if (repoId && repo) fetchGitStatus(repoId, repo, true);
            }}
            disabled={gitStatusEntry?.loading}
          >
            <RefreshCw
              className={`size-3.5 ${gitStatusEntry?.loading ? "animate-spin" : ""}`}
            />
          </button>
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
          className="overflow-y-auto border-l border-border bg-card sm:max-w-xl"
        >
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle className="flex items-center gap-2 text-xl">
              <Settings className="size-5 text-primary" />
              Configuration
            </SheetTitle>
            <SheetDescription>
              Settings, checks, and git sync for {repo.name}
            </SheetDescription>
          </SheetHeader>
          <Tabs defaultValue="settings" className="px-4">
            <TabsList variant="line" className="w-full">
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="checks">Checks</TabsTrigger>
              <TabsTrigger value="git-sync">Git Sync</TabsTrigger>
            </TabsList>

            {/* ── Settings tab ── */}
            <TabsContent value="settings">
              <div className="flex flex-col gap-6 pt-4">
                {repo.type === "ssh" && (
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                      <Terminal className="size-3.5" />
                      Connection
                    </span>
                    <div
                      className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                    >
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          SSH Host
                        </span>
                        <Input
                          type="text"
                          value={
                            (repo as Extract<RepoConfig, { type: "ssh" }>)
                              .sshHost
                          }
                          readOnly
                          disabled
                        />
                      </Label>
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          Remote Path
                        </span>
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
                    </div>
                  </div>
                )}

                {/* Model & Execution */}
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <Cpu className="size-3.5" />
                    Model & Execution
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
                    <div className="grid grid-cols-3 gap-3">
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          Model
                        </span>
                        <Input
                          type="text"
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          disabled={session.running}
                          className="font-mono"
                        />
                      </Label>
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          Effort Level
                        </span>
                        <Select
                          value={effortLevel}
                          onValueChange={setEffortLevel}
                          disabled={session.running}
                        >
                          <SelectTrigger className="font-mono">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="low">low</SelectItem>
                            <SelectItem value="medium">medium</SelectItem>
                            <SelectItem value="high">high</SelectItem>
                            <SelectItem value="max">max</SelectItem>
                          </SelectContent>
                        </Select>
                      </Label>
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          Max Iterations
                        </span>
                        <NumberInput
                          value={maxIterations}
                          onChange={(e) =>
                            setMaxIterations(Number(e.target.value))
                          }
                          min={1}
                          disabled={session.running}
                          className="font-mono"
                        />
                      </Label>
                    </div>
                    <Label className="flex flex-col gap-1">
                      <span className="text-sm text-muted-foreground">
                        Completion Signal
                      </span>
                      <Input
                        type="text"
                        value={completionSignal}
                        onChange={(e) => setCompletionSignal(e.target.value)}
                        disabled={session.running}
                        className="font-mono"
                      />
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Token that signals the agent has finished its task
                      </span>
                    </Label>
                  </div>
                </div>

                {/* Plans */}
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <FileText className="size-3.5" />
                    Plans
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
                    <Label className="flex flex-col gap-1">
                      <span className="text-sm text-muted-foreground">
                        Plans Directory
                      </span>
                      <Input
                        type="text"
                        value={plansDir}
                        onChange={(e) => setPlansDir(e.target.value)}
                        placeholder="docs/plans/"
                        disabled={session.running}
                      />
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Where plan files are read from for session execution
                      </span>
                    </Label>
                    <Label
                      htmlFor="move-plans-completed"
                      className="flex items-center gap-2 text-sm font-normal"
                    >
                      <Checkbox
                        id="move-plans-completed"
                        checked={movePlansToCompleted}
                        onCheckedChange={(v) =>
                          setMovePlansToCompleted(v === true)
                        }
                        disabled={session.running}
                      />
                      Move plans to completed folder after run
                    </Label>
                  </div>
                </div>

                {/* Custom Prompts */}
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <FileDown className="size-3.5" />
                    Custom Prompts
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
                    <Label className="flex flex-col gap-1">
                      <span className="text-sm text-muted-foreground">
                        Design Prompt File
                      </span>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={designPromptFile}
                          onChange={(e) => setDesignPromptFile(e.target.value)}
                          placeholder=".yarr/prompts/design.md"
                          disabled={session.running}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={session.running}
                          onClick={async () => {
                            try {
                              const repoPayload = buildRepoPayload();
                              if (!repoPayload) return;
                              const path = await invoke<string>("export_default_prompt", {
                                repo: repoPayload,
                                promptType: "design",
                              });
                              setDesignPromptFile(path);
                              toast.success("Default design prompt exported");
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          Export Default
                        </Button>
                      </div>
                    </Label>
                    <Label className="flex flex-col gap-1">
                      <span className="text-sm text-muted-foreground">
                        Implementation Prompt File
                      </span>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={implementationPromptFile}
                          onChange={(e) => setImplementationPromptFile(e.target.value)}
                          placeholder=".yarr/prompts/implementation.md"
                          disabled={session.running}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={session.running}
                          onClick={async () => {
                            try {
                              const repoPayload = buildRepoPayload();
                              if (!repoPayload) return;
                              const path = await invoke<string>("export_default_prompt", {
                                repo: repoPayload,
                                promptType: "implementation",
                              });
                              setImplementationPromptFile(path);
                              toast.success("Default implementation prompt exported");
                            } catch (e) {
                              toast.error(String(e));
                            }
                          }}
                        >
                          Export Default
                        </Button>
                      </div>
                    </Label>
                    <span className="text-xs text-muted-foreground mt-0.5">
                      Override the built-in prompt. Leave empty to use default.
                    </span>
                  </div>
                </div>

                {/* Behavior */}
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <Settings className="size-3.5" />
                    Behavior
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
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
                    <div className="flex flex-col gap-1">
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
                      </Label>
                      <span className="text-xs text-muted-foreground ml-6 mt-0.5">
                        Fetches from remote every 30 seconds during a session
                      </span>
                    </div>
                  </div>
                </div>

                {/* Environment Variables */}
                <fieldset
                  disabled={session.running}
                  className="flex flex-col gap-3"
                >
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <Variable className="size-3.5" />
                    Environment Variables
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
                    {envVars.length === 0 && (
                      <div className="border border-dashed border-border rounded-md p-4 text-center">
                        <span className="text-xs text-muted-foreground">
                          No environment variables set
                        </span>
                      </div>
                    )}
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
                          className="flex-1 font-mono"
                        />
                        <span className="text-muted-foreground">=</span>
                        <Input
                          type="text"
                          value={envVar.value}
                          onChange={(e) => {
                            const updated = [...envVars];
                            updated[i] = {
                              ...updated[i],
                              value: e.target.value,
                            };
                            setEnvVars(updated);
                          }}
                          placeholder="value"
                          className="flex-1 font-mono"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setEnvVars(envVars.filter((_, j) => j !== i))
                          }
                          aria-label="Remove variable"
                        >
                          <X className="size-3.5" />
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
                      <Plus className="size-3.5" />
                      Add Variable
                    </Button>
                  </div>
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
                        {step.status === "running" ? (
                          <Loader2 className="size-4 text-muted-foreground animate-spin" />
                        ) : step.status === "pass" ? (
                          <CheckIcon className="size-4 text-success" />
                        ) : step.status === "fail" ? (
                          <XCircle className="size-4 text-destructive" />
                        ) : (
                          <span className="size-4 flex items-center justify-center text-muted-foreground">
                            <span className="size-1.5 rounded-full bg-muted-foreground" />
                          </span>
                        )}
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
              <div className="flex flex-col gap-6 pt-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5" />
                    Validation Checks
                  </span>
                  <Button
                    type="button"
                    variant="outline"
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
                    <Plus className="size-3.5" />
                    Add Check
                  </Button>
                </div>
                {checks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border p-6 flex flex-col items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      No checks configured
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Add a check to run validation during or after sessions
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {checks.map((check, i) => (
                      <div
                        key={i}
                        className={`check-entry rounded-md border border-border border-l-2 border-l-primary/40 flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                      >
                        {/* Header: inline-editable name + when toggle + delete */}
                        <div className="flex items-center gap-2 px-3 pt-3 pb-0">
                          <Input
                            type="text"
                            value={check.name}
                            placeholder={`Check ${i + 1}`}
                            onChange={(e) => {
                              const updated = [...checks];
                              updated[i] = {
                                ...updated[i],
                                name: e.target.value,
                              };
                              setChecks(updated);
                            }}
                            disabled={session.running}
                            className="h-7 border-none bg-transparent shadow-none px-0 text-sm font-medium text-foreground placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:border-none"
                          />
                          <div className="flex items-center shrink-0">
                            <div className="flex h-7 rounded-md border border-input overflow-hidden">
                              <button
                                type="button"
                                disabled={session.running}
                                onClick={() => {
                                  const updated = [...checks];
                                  updated[i] = {
                                    ...updated[i],
                                    when: "each_iteration",
                                  };
                                  setChecks(updated);
                                }}
                                className={`px-2.5 text-xs font-medium transition-colors duration-150 ${
                                  check.when === "each_iteration"
                                    ? "bg-primary/15 text-primary"
                                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                } disabled:pointer-events-none disabled:opacity-50`}
                              >
                                Every iteration
                              </button>
                              <button
                                type="button"
                                disabled={session.running}
                                onClick={() => {
                                  const updated = [...checks];
                                  updated[i] = {
                                    ...updated[i],
                                    when: "post_completion",
                                  };
                                  setChecks(updated);
                                }}
                                className={`px-2.5 text-xs font-medium border-l border-input transition-colors duration-150 ${
                                  check.when === "post_completion"
                                    ? "bg-primary/15 text-primary"
                                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                                } disabled:pointer-events-none disabled:opacity-50`}
                              >
                                After completion
                              </button>
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            disabled={session.running}
                            onClick={() => {
                              setChecks(checks.filter((_, j) => j !== i));
                            }}
                            aria-label="Remove check"
                            className="shrink-0"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </div>
                        {/* Fields: command + timeout */}
                        <div className="grid grid-cols-[1fr_auto] gap-2 px-3">
                          <Label className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                              Command
                            </span>
                            <Input
                              type="text"
                              value={check.command}
                              placeholder="e.g. npm test"
                              onChange={(e) => {
                                const updated = [...checks];
                                updated[i] = {
                                  ...updated[i],
                                  command: e.target.value,
                                };
                                setChecks(updated);
                              }}
                              disabled={session.running}
                              className="font-mono"
                            />
                          </Label>
                          <Label className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                              Timeout (s)
                            </span>
                            <NumberInput
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
                              className="font-mono w-24"
                            />
                          </Label>
                        </div>

                        {/* On Failure collapsible section */}
                        <Collapsible>
                          <CollapsibleTrigger className="flex items-center gap-1.5 px-3 pb-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer select-none group">
                            <ChevronRight className="size-3 transition-transform duration-200 group-data-[state=open]:rotate-90" />
                            On Failure
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="bg-card-inset rounded-md p-3 mx-3 mb-3 flex flex-col gap-3">
                              {/* Row 1: Model + Retries */}
                              <div className="grid grid-cols-[1fr_auto] gap-2">
                                <Label className="flex flex-col gap-1">
                                  <span className="text-xs text-muted-foreground">
                                    Model
                                  </span>
                                  <Input
                                    type="text"
                                    value={check.model ?? ""}
                                    placeholder="Inherit from session"
                                    onChange={(e) => {
                                      const updated = [...checks];
                                      updated[i] = {
                                        ...updated[i],
                                        model: e.target.value || undefined,
                                      };
                                      setChecks(updated);
                                    }}
                                    disabled={session.running}
                                    className="font-mono"
                                  />
                                </Label>
                                <Label className="flex flex-col gap-1">
                                  <span className="text-xs text-muted-foreground">
                                    Retries
                                  </span>
                                  <NumberInput
                                    value={check.maxRetries}
                                    onChange={(e) => {
                                      const updated = [...checks];
                                      updated[i] = {
                                        ...updated[i],
                                        maxRetries: Number(e.target.value),
                                      };
                                      setChecks(updated);
                                    }}
                                    min={1}
                                    disabled={session.running}
                                    className="font-mono w-20"
                                  />
                                </Label>
                              </div>
                              {/* Row 2: Fix Prompt */}
                              <Label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                  Fix Prompt
                                </span>
                                <Textarea
                                  value={check.prompt ?? ""}
                                  placeholder="e.g. Fix all lint errors in the codebase."
                                  onChange={(e) => {
                                    const updated = [...checks];
                                    updated[i] = {
                                      ...updated[i],
                                      prompt: e.target.value || undefined,
                                    };
                                    setChecks(updated);
                                  }}
                                  disabled={session.running}
                                  rows={3}
                                  className="font-mono"
                                />
                                <span className="text-xs text-muted-foreground mt-0.5">
                                  Leave blank for default prompt. Use{" "}
                                  {"{{output}}"} to inject check output,{" "}
                                  {"{{command}}"} for the check command,{" "}
                                  {"{{name}}"} for the check name.
                                </span>
                              </Label>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            {/* ── Git Sync tab ── */}
            <TabsContent value="git-sync">
              <div className="flex flex-col gap-6 pt-4">
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <GitBranch className="size-3.5" />
                    Sync Settings
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
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
                    <div className="grid grid-cols-2 gap-3">
                      <Label className="flex flex-col gap-1">
                        <span className="text-sm text-muted-foreground">
                          Model
                        </span>
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
                        <span className="text-sm text-muted-foreground">
                          Max Push Retries
                        </span>
                        <NumberInput
                          value={gitSyncMaxRetries}
                          onChange={(e) =>
                            setGitSyncMaxRetries(Number(e.target.value))
                          }
                          min={1}
                          disabled={session.running || !gitSyncEnabled}
                          className="font-mono"
                        />
                      </Label>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <span className="text-xs font-mono uppercase tracking-widest text-primary-light flex items-center gap-1.5">
                    <GitBranch className="size-3.5" />
                    Conflict Resolution
                  </span>
                  <div
                    className={`flex flex-col gap-3 ${session.running ? "opacity-60" : ""}`}
                  >
                    <Label className="flex flex-col gap-1">
                      <span className="text-sm text-muted-foreground">
                        Prompt
                      </span>
                      <Textarea
                        value={gitSyncPrompt}
                        onChange={(e) => setGitSyncPrompt(e.target.value)}
                        placeholder="Resolve merge conflicts..."
                        disabled={session.running || !gitSyncEnabled}
                        rows={3}
                      />
                      <span className="text-xs text-muted-foreground mt-0.5">
                        Instructions given to the agent when resolving merge
                        conflicts
                      </span>
                    </Label>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
          <SheetFooter className="sticky bottom-0 bg-card border-t border-border pt-4 shadow-[0_-4px_12px_oklch(0_0_0/0.3)]">
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
        {oneShotOpen && (
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
                Design Effort Level
              </Label>
              <Select
                value={oneShotDesignEffortLevel}
                onValueChange={setOneShotDesignEffortLevel}
                disabled={oneShotSubmitting}
              >
                <SelectTrigger className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-sm text-muted-foreground">
                Implementation Effort Level
              </Label>
              <Select
                value={oneShotEffortLevel}
                onValueChange={setOneShotEffortLevel}
                disabled={oneShotSubmitting}
              >
                <SelectTrigger className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="max">max</SelectItem>
                </SelectContent>
              </Select>
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

      <Tabs
        defaultValue="session"
        onValueChange={(v) => {
          if (v === "history" && !historyLoadedRef.current) {
            fetchHistory();
          }
        }}
      >
        <TabsList variant="line">
          <TabsTrigger value="session">Session</TabsTrigger>
          <TabsTrigger value="history">
            History
            {historyLoadedRef.current && historyTraces.length > 0 && (
              <span className="text-xs text-muted-foreground ml-1">
                ({historyTraces.length})
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="session">
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
              planProgress={session.planProgress}
            />
          )}

          {/* Error section */}
          {session.error && (
            <section className="bg-destructive/10 border border-destructive/30 rounded-md p-4 mt-4">
              <h2 className="text-lg font-semibold text-destructive mb-2">
                Error
              </h2>
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
                <dd className="font-mono text-xs">
                  {session.trace.session_id}
                </dd>
              </dl>
            </section>
          )}
        </TabsContent>

        <TabsContent value="history">
          <HistoryTable
            traces={historyTraces}
            loading={historyLoading}
            error={historyError}
            showRepo={false}
            showType={false}
            repos={repos}
            repoId={repoId}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
