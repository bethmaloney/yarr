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

import { loadRepos, addRepo, updateRepo, removeRepo, type RepoConfig } from './repos';

beforeEach(() => {
  mockData.clear();
});

describe('loadRepos', () => {
  it('returns empty array when no data', async () => {
    const result = await loadRepos();
    expect(result).toEqual([]);
  });

  it('returns stored repos when they exist', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'abc-123',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        id: 'def-456',
        path: '/home/beth/repos/other',
        name: 'other',
        model: 'sonnet',
        maxIterations: 20,
        completionSignal: 'DONE',
      },
    ];
    mockData.set('repos', existing);

    const result = await loadRepos();
    expect(result).toEqual(existing);
  });
});

describe('addRepo', () => {
  it('generates an id that is a non-empty string', async () => {
    const repo = await addRepo('/home/beth/repos/yarr');
    expect(typeof repo.id).toBe('string');
    expect(repo.id.length).toBeGreaterThan(0);
  });

  it('derives name from path basename', async () => {
    const repo = await addRepo('/home/beth/repos/yarr');
    expect(repo.name).toBe('yarr');
  });

  it('derives name correctly from path with trailing slash', async () => {
    const repo = await addRepo('/home/beth/repos/yarr/');
    expect(repo.name).toBe('yarr');
  });

  it('applies defaults for model, maxIterations, and completionSignal', async () => {
    const repo = await addRepo('/home/beth/repos/yarr');
    expect(repo.model).toBe('opus');
    expect(repo.maxIterations).toBe(40);
    expect(repo.completionSignal).toBe('ALL TODO ITEMS COMPLETE');
  });

  it('appends to existing repos', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'existing-id',
        path: '/home/beth/repos/first',
        name: 'first',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    await addRepo('/home/beth/repos/second');

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe('first');
    expect(stored[1].name).toBe('second');
  });

  it('returns the created RepoConfig', async () => {
    const repo = await addRepo('/home/beth/repos/yarr');
    expect(repo).toEqual({
      id: expect.any(String),
      path: '/home/beth/repos/yarr',
      name: 'yarr',
      model: 'opus',
      maxIterations: 40,
      completionSignal: 'ALL TODO ITEMS COMPLETE',
    });
  });
});

describe('updateRepo', () => {
  it('replaces matching repo by id', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    const updated: RepoConfig = {
      id: 'repo-1',
      path: '/home/beth/repos/yarr',
      name: 'yarr',
      model: 'sonnet',
      maxIterations: 10,
      completionSignal: 'FINISHED',
    };
    await updateRepo(updated);

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].model).toBe('sonnet');
    expect(stored[0].maxIterations).toBe(10);
    expect(stored[0].completionSignal).toBe('FINISHED');
  });

  it('does not affect other repos', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        id: 'repo-2',
        path: '/home/beth/repos/other',
        name: 'other',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    const updated: RepoConfig = {
      id: 'repo-1',
      path: '/home/beth/repos/yarr',
      name: 'yarr',
      model: 'sonnet',
      maxIterations: 10,
      completionSignal: 'FINISHED',
    };
    await updateRepo(updated);

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[1]).toEqual(existing[1]);
  });
});

describe('removeRepo', () => {
  it('filters out repo by id', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    await removeRepo('repo-1');

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toEqual([]);
  });

  it('does not affect other repos', async () => {
    const existing: RepoConfig[] = [
      {
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        id: 'repo-2',
        path: '/home/beth/repos/other',
        name: 'other',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    await removeRepo('repo-1');

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe('repo-2');
    expect(stored[0]).toEqual(existing[1]);
  });
});
