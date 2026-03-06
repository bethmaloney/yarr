import { vi, describe, it, expect, beforeEach } from 'vitest';

const { mockData } = vi.hoisted(() => {
  return { mockData: new Map<string, unknown>() };
});

vi.mock('@tauri-apps/plugin-store', () => {
  return {
    LazyStore: class {
      async get<T>(key: string): Promise<T | undefined> {
        return mockData.get(key) as T | undefined;
      }
      async set(key: string, value: unknown): Promise<void> {
        mockData.set(key, value);
      }
      async save(): Promise<void> {}
    },
  };
});

import { loadRecents, saveRecent } from './recents';

beforeEach(() => {
  mockData.clear();
});

describe('loadRecents', () => {
  it('returns empty arrays when store has no data', async () => {
    const result = await loadRecents();
    expect(result).toEqual({ repoPaths: [], promptFiles: [] });
  });

  it('returns stored paths when they exist', async () => {
    mockData.set('repoPaths', ['/home/user/repo1', '/home/user/repo2']);
    mockData.set('promptFiles', ['/home/user/prompt.md']);

    const result = await loadRecents();
    expect(result).toEqual({
      repoPaths: ['/home/user/repo1', '/home/user/repo2'],
      promptFiles: ['/home/user/prompt.md'],
    });
  });

  it('returns empty array for one key when only the other is set', async () => {
    mockData.set('repoPaths', ['/home/user/repo1']);

    const result = await loadRecents();
    expect(result).toEqual({
      repoPaths: ['/home/user/repo1'],
      promptFiles: [],
    });
  });
});

describe('saveRecent', () => {
  it('adds a path to the front of the array', async () => {
    mockData.set('repoPaths', ['/home/user/repo1']);

    await saveRecent('repoPaths', '/home/user/repo2');

    const stored = mockData.get('repoPaths') as string[];
    expect(stored[0]).toBe('/home/user/repo2');
    expect(stored[1]).toBe('/home/user/repo1');
  });

  it('deduplicates by moving existing path to front', async () => {
    mockData.set('repoPaths', ['/home/user/repo1', '/home/user/repo2', '/home/user/repo3']);

    await saveRecent('repoPaths', '/home/user/repo2');

    const stored = mockData.get('repoPaths') as string[];
    expect(stored).toEqual(['/home/user/repo2', '/home/user/repo1', '/home/user/repo3']);
  });

  it('caps at 5 entries, dropping the oldest', async () => {
    mockData.set('repoPaths', ['/r/1', '/r/2', '/r/3', '/r/4', '/r/5']);

    await saveRecent('repoPaths', '/r/new');

    const stored = mockData.get('repoPaths') as string[];
    expect(stored).toHaveLength(5);
    expect(stored).toEqual(['/r/new', '/r/1', '/r/2', '/r/3', '/r/4']);
  });

  it('calls store.save() after setting', async () => {
    const { LazyStore } = await import('@tauri-apps/plugin-store');
    const saveSpy = vi.spyOn(LazyStore.prototype, 'save');

    await saveRecent('promptFiles', '/home/user/prompt.md');

    expect(saveSpy).toHaveBeenCalled();
    saveSpy.mockRestore();
  });

  it('does not change order when re-saving path already at front', async () => {
    mockData.set('repoPaths', ['/r/1', '/r/2', '/r/3']);

    await saveRecent('repoPaths', '/r/1');

    const stored = mockData.get('repoPaths') as string[];
    expect(stored).toEqual(['/r/1', '/r/2', '/r/3']);
  });

  it('works with an empty initial array', async () => {
    await saveRecent('promptFiles', '/home/user/prompt.md');

    const stored = mockData.get('promptFiles') as string[];
    expect(stored).toEqual(['/home/user/prompt.md']);
  });
});
