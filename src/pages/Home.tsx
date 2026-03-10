import { useState } from "react";
import { useNavigate } from "react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../store";
import { useBranchInfo } from "../hooks/useBranchInfo";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { RepoCard } from "@/components/RepoCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RepoStatus } from "../types";

export default function Home() {
  const repos = useAppStore((s) => s.repos);
  const sessions = useAppStore((s) => s.sessions);
  const latestTraces = useAppStore((s) => s.latestTraces);
  const addLocalRepo = useAppStore((s) => s.addLocalRepo);
  const addSshRepo = useAppStore((s) => s.addSshRepo);

  const [addMode, setAddMode] = useState<null | "choosing" | "ssh-form">(null);
  const [sshHost, setSshHost] = useState("");
  const [sshRemotePath, setSshRemotePath] = useState("");

  const branchInfos = useBranchInfo(repos);
  const navigate = useNavigate();

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

  return (
    <main className="max-w-[900px] mx-auto p-8">
      <Breadcrumbs crumbs={[{ label: "Home" }]} />
      <header className="toolbar-header flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl text-primary font-bold">Yarr</h1>
          <p className="subtitle text-sm text-muted-foreground mt-1">
            Claude Orchestrator
          </p>
        </div>
        <div className="flex gap-2 items-center pt-2">
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

      {repos.length === 0 ? (
        <div className="text-center text-muted-foreground py-16">
          <p>No repos configured yet.</p>
          <p>Click &quot;Add repo&quot; to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {repos.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              status={deriveStatus(repo.id)}
              lastTrace={latestTraces.get(repo.id)}
              branchName={branchInfos.get(repo.id)?.name}
              onClick={() => navigate(`/repo/${repo.id}`)}
            />
          ))}
        </div>
      )}
    </main>
  );
}
