import { LazyStore } from "@tauri-apps/plugin-store";

const store = new LazyStore("recents.json");

export async function loadRecents(): Promise<{ repoPaths: string[]; promptFiles: string[] }> {
  const repoPaths = await store.get<string[]>("repoPaths");
  const promptFiles = await store.get<string[]>("promptFiles");
  return { repoPaths: repoPaths ?? [], promptFiles: promptFiles ?? [] };
}

export async function saveRecent(key: "repoPaths" | "promptFiles", path: string): Promise<void> {
  const current = (await store.get<string[]>(key)) ?? [];
  const filtered = current.filter((p) => p !== path);
  const updated = [path, ...filtered].slice(0, 5);
  await store.set(key, updated);
  await store.save();
}
