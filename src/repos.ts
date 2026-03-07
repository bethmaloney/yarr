import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("repos.json");

export type RepoConfig = {
  id: string;
  path: string;
  name: string;
  model: string;
  maxIterations: number;
  completionSignal: string;
};

export async function loadRepos(): Promise<RepoConfig[]> {
  const repos = await store.get<RepoConfig[]>("repos");
  return repos ?? [];
}

export async function addRepo(path: string): Promise<RepoConfig> {
  const repos = await loadRepos();
  const name = path.replace(/\/+$/, "").split("/").pop() || path;
  const repo: RepoConfig = {
    id: crypto.randomUUID(),
    path,
    name,
    model: "opus",
    maxIterations: 40,
    completionSignal: "ALL TODO ITEMS COMPLETE",
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
