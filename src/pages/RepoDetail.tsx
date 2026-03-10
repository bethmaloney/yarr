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
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
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
} from "lucide-react";
import type { BranchInfo, Check, SessionState } from "../types";
import type { RepoConfig } from "../repos";

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
  const [plansDir, setPlansDir] = useState("");
  const [gitSyncEnabled, setGitSyncEnabled] = useState(false);
  const [gitSyncModel, setGitSyncModel] = useState("");
  const [gitSyncMaxRetries, setGitSyncMaxRetries] = useState(3);
  const [gitSyncPrompt, setGitSyncPrompt] = useState("");

  // Config sheet state
  const [configOpen, setConfigOpen] = useState(false);

  // Branch state
  const [branchInfo, setBranchInfo] = useState<BranchInfo | null>(null);
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
    setPlansDir(repo.plansDir ?? "");
    setGitSyncEnabled(repo.gitSync?.enabled ?? false);
    setGitSyncModel(repo.gitSync?.model ?? "");
    setGitSyncMaxRetries(repo.gitSync?.maxPushRetries ?? 3);
    setGitSyncPrompt(repo.gitSync?.conflictPrompt ?? "");
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

  // Fetch branch info on mount and when repo changes
  useEffect(() => {
    if (!repo) return;
    const payload = buildRepoPayload();
    if (!payload) return;
    invoke<BranchInfo>("get_branch_info", { repo: payload })
      .then((info) => setBranchInfo(info))
      .catch(() => setBranchInfo(null));
  }, [repo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh branch info after session completes
  useEffect(() => {
    if (wasRunningRef.current && !session.running) {
      const payload = buildRepoPayload();
      if (payload) {
        invoke<BranchInfo>("get_branch_info", { repo: payload })
          .then((info) => setBranchInfo(info))
          .catch(() => setBranchInfo(null));
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
      .catch(() => {
        if (currentFile === planFile) {
          setPreviewContent("");
          setPreviewLoading(false);
        }
      });
  }, [planFile]);

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

    invoke("test_ssh_connection_steps", {
      sshHost: ssh.sshHost,
      remotePath: ssh.remotePath,
    }).catch(() => {
      setConnectionTest((prev) => (prev ? { ...prev, running: false } : null));
      unlistenStep();
      unlistenComplete();
    });
  }

  async function fetchBranches() {
    const payload = buildRepoPayload();
    if (!payload) return;
    try {
      const result = await invoke<string[]>("list_local_branches", {
        repo: payload,
      });
      setBranches(result);
    } catch {
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
      const info = await invoke<BranchInfo>("get_branch_info", {
        repo: payload,
      });
      setBranchInfo(info);
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
      const info = await invoke<BranchInfo>("get_branch_info", {
        repo: payload,
      });
      setBranchInfo(info);
      toast.success(`Switched to ${branchName}`);
    } catch (e) {
      console.error("Failed to switch branch:", e);
      toast.error(`Failed to switch branch: ${e}`);
    }
  }

  async function fetchPlans() {
    const payload = buildRepoPayload();
    if (!payload) return;
    try {
      const result = await invoke<string[]>("list_plans", {
        repo: payload,
        plansDir: (repo!.plansDir || "docs/plans/").replace(/\/?$/, "/"),
      });
      setPlans(result);
    } catch {
      setPlans([]);
    }
  }

  function handleSelectPlan(filename: string) {
    const dir = (repo!.plansDir || "docs/plans/").replace(/\/?$/, "/");
    setPlanFile(`${dir}${filename}`);
    setPlanDropdownOpen(false);
    setPlanSearch("");
  }

  // Context percentage computation
  const ctxPercent =
    session.trace?.context_window && session.trace?.final_context_tokens
      ? Math.round(
          (session.trace.final_context_tokens / session.trace.context_window) *
            100,
        )
      : null;

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

      {/* Branch selector */}
      {branchInfo && (
        <div className="mb-6">
          {session.running ? (
            <button
              className={`branch-chip inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-secondary text-secondary-foreground${branchInfo.behind && branchInfo.behind > 0 ? " warning border border-warning" : ""}`}
              disabled
            >
              {branchInfo.name}
              {branchInfo.ahead != null && branchInfo.ahead > 0 && (
                <span className="text-xs opacity-70">
                  {"\u2191"}
                  {branchInfo.ahead}
                </span>
              )}
              {branchInfo.behind != null && branchInfo.behind > 0 && (
                <span className="text-xs opacity-70">
                  {"\u2193"}
                  {branchInfo.behind}
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
                  className={`branch-chip inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm bg-secondary text-secondary-foreground hover:bg-secondary/80 cursor-pointer${branchInfo.behind && branchInfo.behind > 0 ? " warning border border-warning" : ""}`}
                  onClick={() => {
                    if (!branchDropdownOpen) fetchBranches();
                  }}
                >
                  {branchInfo.name}
                  {branchInfo.ahead != null && branchInfo.ahead > 0 && (
                    <span className="text-xs opacity-70">
                      {"\u2191"}
                      {branchInfo.ahead}
                    </span>
                  )}
                  {branchInfo.behind != null && branchInfo.behind > 0 && (
                    <span className="text-xs opacity-70">
                      {"\u2193"}
                      {branchInfo.behind}
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
                {branchInfo.behind != null && branchInfo.behind > 0 && (
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
                        className={`branch-item${branch === branchInfo?.name ? " active font-bold" : ""}`}
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
        <SheetContent side="right" className="overflow-y-auto border-l border-border bg-card">
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
                          (repo as Extract<RepoConfig, { type: "ssh" }>).remotePath
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
                <Label htmlFor="create-branch" className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    id="create-branch"
                    checked={createBranch}
                    onCheckedChange={(v) => setCreateBranch(v === true)}
                    disabled={session.running}
                  />
                  Create branch on run
                </Label>
                <fieldset disabled={session.running} className="flex flex-col gap-3">
                  <legend className="text-sm font-medium mb-2">Environment Variables</legend>
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
                    onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
                  >
                    + Add Variable
                  </Button>
                </fieldset>
                {connectionTest && (
                  <div data-testid="connection-checklist" className="flex flex-col gap-2 mt-2">
                    {connectionTest.steps.map((step) => (
                      <div key={step.name} className={`step-${step.status} flex items-center gap-2 text-sm`}>
                        <span className={step.status === "pass" ? "text-success" : step.status === "fail" ? "text-destructive" : "text-muted-foreground"}>
                          {step.status === "running"
                            ? "..."
                            : step.status === "pass"
                              ? "\u2713"
                              : step.status === "fail"
                                ? "\u2717"
                                : "\u00B7"}
                        </span>
                        <span>{step.name}</span>
                        {step.error && <span className="text-destructive text-xs">{step.error}</span>}
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
                                updated[i] = { ...updated[i], name: e.target.value };
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
                                <SelectItem value="each_iteration">each_iteration</SelectItem>
                                <SelectItem value="post_completion">post_completion</SelectItem>
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
                <Label htmlFor="git-sync-enabled" className="flex items-center gap-2 text-sm font-normal">
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
                      onChange={(e) => setGitSyncMaxRetries(Number(e.target.value))}
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
                disabled={session.running}
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
                  <CommandEmpty>No plans found</CommandEmpty>
                  {filteredPlans.map((plan) => (
                    <CommandItem
                      key={plan}
                      value={plan}
                      className={plan === selectedPlanName ? "font-bold" : ""}
                      onSelect={() => handleSelectPlan(plan)}
                    >
                      {plan}
                    </CommandItem>
                  ))}
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
        {previewLoading && <p className="text-sm text-muted-foreground mt-2">Loading...</p>}
        {!previewLoading && previewContent && (
          <pre className="mt-3 p-3 bg-card border border-border rounded-md text-xs text-foreground overflow-x-auto max-h-48 overflow-y-auto">{previewContent}</pre>
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
                onClick={() => navigate(`/repo/${repoId}/oneshot`)}
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
      </section>

      {/* Disconnected banner */}
      {session.disconnected && (
        <section className="bg-destructive/10 border border-destructive/30 rounded-md p-4 mb-4">
          <p className="text-destructive font-medium">
            {session.disconnectReason
              ? `Connection lost: ${session.disconnectReason}`
              : "Connection lost"}
          </p>
          <p className="text-sm text-muted-foreground mt-1">The remote session may still be running.</p>
        </section>
      )}

      {/* Events list or empty state */}
      {session.events.length === 0 && !session.running && !session.error && !session.trace ? (
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
          <pre className="text-sm text-destructive whitespace-pre-wrap">{session.error}</pre>
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
                <dd className="text-destructive">{session.trace.failure_reason}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Iterations</dt>
            <dd>{session.trace.total_iterations}</dd>
            <dt className="text-muted-foreground">Total Cost</dt>
            <dd>${session.trace.total_cost_usd.toFixed(4)}</dd>
            {ctxPercent !== null && (
              <>
                <dt className="text-muted-foreground">Context</dt>
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
