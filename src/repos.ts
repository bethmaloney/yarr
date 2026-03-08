import { LazyStore } from "@tauri-apps/plugin-store";
import type { Check, GitSyncConfig } from "./types";

const store = new LazyStore("repos.json");

type LocalRepoConfig = {
  type: "local";
  id: string;
  path: string;
  name: string;
  model: string;
  maxIterations: number;
  completionSignal: string;
  envVars?: Record<string, string>;
  checks?: Check[];
  gitSync?: GitSyncConfig;
};

type SshRepoConfig = {
  type: "ssh";
  id: string;
  sshHost: string;
  remotePath: string;
  name: string;
  model: string;
  maxIterations: number;
  completionSignal: string;
  envVars?: Record<string, string>;
  checks?: Check[];
  gitSync?: GitSyncConfig;
};

export type RepoConfig = LocalRepoConfig | SshRepoConfig;

export async function loadRepos(): Promise<RepoConfig[]> {
  const repos = await store.get<Record<string, unknown>[]>("repos");
  if (!repos) return [];
  return repos.map((r) => {
    if (!r.type) {
      r.type = "local";
    }
    if (!r.checks) {
      r.checks = [];
    }
    return r as RepoConfig;
  });
}

export async function addLocalRepo(path: string): Promise<RepoConfig> {
  const repos = await loadRepos();
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
  const repo: LocalRepoConfig = {
    type: "local",
    id: crypto.randomUUID(),
    path,
    name,
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
  };
  repos.push(repo);
  await store.set("repos", repos);
  await store.save();
  return repo;
}

export async function addSshRepo(
  sshHost: string,
  remotePath: string,
): Promise<RepoConfig> {
  const repos = await loadRepos();
  const name = remotePath.replace(/\/+$/, "").split("/").pop() || remotePath;
  const repo: SshRepoConfig = {
    type: "ssh",
    id: crypto.randomUUID(),
    sshHost,
    remotePath,
    name,
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
    checks: [],
  };
  repos.push(repo);
  await store.set("repos", repos);
  await store.save();
  return repo;
}

export async function updateRepo(repo: RepoConfig): Promise<void> {
  const repos = await loadRepos();
  const updated = repos.map((r) => (r.id === repo.id ? repo : r));
  await store.set("repos", updated);
  await store.save();
}

export async function removeRepo(id: string): Promise<void> {
  const repos = await loadRepos();
  const filtered = repos.filter((r) => r.id !== id);
  await store.set("repos", filtered);
  await store.save();
}
