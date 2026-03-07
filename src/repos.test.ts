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

import { loadRepos, addLocalRepo, addSshRepo, updateRepo, removeRepo, type RepoConfig } from './repos';

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
        type: 'local',
        id: 'abc-123',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        type: 'ssh',
        id: 'def-456',
        sshHost: 'dev-server',
        remotePath: '/home/beth/repos/other',
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

  it('migrates legacy repos without type field to local', async () => {
    const legacyRepos = [
      {
        id: 'legacy-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        id: 'legacy-2',
        path: '/home/beth/repos/other',
        name: 'other',
        model: 'sonnet',
        maxIterations: 20,
        completionSignal: 'DONE',
      },
    ];
    mockData.set('repos', legacyRepos);

    const result = await loadRepos();
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('local');
    expect(result[1].type).toBe('local');
  });

  it('preserves existing type field during migration', async () => {
    const repos = [
      {
        type: 'local',
        id: 'local-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', repos);

    const result = await loadRepos();
    expect(result[0].type).toBe('local');
  });

  it('does not alter SSH repos that already have type ssh', async () => {
    const repos = [
      {
        type: 'ssh',
        id: 'ssh-1',
        sshHost: 'dev-server',
        remotePath: '/home/beth/repos/project',
        name: 'project',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', repos);

    const result = await loadRepos();
    expect(result[0].type).toBe('ssh');
    if (result[0].type === 'ssh') {
      expect(result[0].sshHost).toBe('dev-server');
      expect(result[0].remotePath).toBe('/home/beth/repos/project');
    }
  });
});

describe('addLocalRepo', () => {
  it('generates an id that is a non-empty string', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(typeof repo.id).toBe('string');
    expect(repo.id.length).toBeGreaterThan(0);
  });

  it('creates a repo with type local', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(repo.type).toBe('local');
  });

  it('creates a repo with path field', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    if (repo.type === 'local') {
      expect(repo.path).toBe('/home/beth/repos/yarr');
    }
  });

  it('derives name from path basename', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(repo.name).toBe('yarr');
  });

  it('derives name correctly from path with trailing slash', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr/');
    expect(repo.name).toBe('yarr');
  });

  it('applies defaults for model, maxIterations, and completionSignal', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(repo.model).toBe('opus');
    expect(repo.maxIterations).toBe(40);
    expect(repo.completionSignal).toBe('ALL TODO ITEMS COMPLETE');
  });

  it('appends to existing repos', async () => {
    const existing: RepoConfig[] = [
      {
        type: 'local',
        id: 'existing-id',
        path: '/home/beth/repos/first',
        name: 'first',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    await addLocalRepo('/home/beth/repos/second');

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe('first');
    expect(stored[1].name).toBe('second');
  });

  it('returns the created RepoConfig', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(repo).toEqual({
      type: 'local',
      id: expect.any(String),
      path: '/home/beth/repos/yarr',
      name: 'yarr',
      model: 'opus',
      maxIterations: 40,
      completionSignal: 'ALL TODO ITEMS COMPLETE',
    });
  });
});

describe('addSshRepo', () => {
  it('generates an id that is a non-empty string', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(typeof repo.id).toBe('string');
    expect(repo.id.length).toBeGreaterThan(0);
  });

  it('creates a repo with type ssh', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(repo.type).toBe('ssh');
  });

  it('creates a repo with sshHost and remotePath fields', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    if (repo.type === 'ssh') {
      expect(repo.sshHost).toBe('dev-server');
      expect(repo.remotePath).toBe('/home/beth/repos/project');
    }
  });

  it('derives name from remote path basename', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(repo.name).toBe('project');
  });

  it('derives name correctly from remote path with trailing slash', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project/');
    expect(repo.name).toBe('project');
  });

  it('applies defaults for model, maxIterations, and completionSignal', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(repo.model).toBe('opus');
    expect(repo.maxIterations).toBe(40);
    expect(repo.completionSignal).toBe('ALL TODO ITEMS COMPLETE');
  });

  it('appends to existing repos', async () => {
    const existing: RepoConfig[] = [
      {
        type: 'local',
        id: 'existing-id',
        path: '/home/beth/repos/first',
        name: 'first',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    await addSshRepo('dev-server', '/home/beth/repos/second');

    const stored = mockData.get('repos') as RepoConfig[];
    expect(stored).toHaveLength(2);
    expect(stored[0].name).toBe('first');
    expect(stored[1].name).toBe('second');
  });

  it('returns the created RepoConfig', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(repo).toEqual({
      type: 'ssh',
      id: expect.any(String),
      sshHost: 'dev-server',
      remotePath: '/home/beth/repos/project',
      name: 'project',
      model: 'opus',
      maxIterations: 40,
      completionSignal: 'ALL TODO ITEMS COMPLETE',
    });
  });
});

describe('type discrimination', () => {
  it('local repo has path but not sshHost or remotePath', async () => {
    const repo = await addLocalRepo('/home/beth/repos/yarr');
    expect(repo.type).toBe('local');
    if (repo.type === 'local') {
      expect(repo.path).toBe('/home/beth/repos/yarr');
      // TypeScript would prevent accessing sshHost/remotePath on a local repo
      // but at runtime we verify these fields are not present
      expect('sshHost' in repo).toBe(false);
      expect('remotePath' in repo).toBe(false);
    }
  });

  it('ssh repo has sshHost and remotePath but not path', async () => {
    const repo = await addSshRepo('dev-server', '/home/beth/repos/project');
    expect(repo.type).toBe('ssh');
    if (repo.type === 'ssh') {
      expect(repo.sshHost).toBe('dev-server');
      expect(repo.remotePath).toBe('/home/beth/repos/project');
      // TypeScript would prevent accessing path on an SSH repo
      // but at runtime we verify the field is not present
      expect('path' in repo).toBe(false);
    }
  });
});

describe('updateRepo', () => {
  it('replaces matching repo by id', async () => {
    const existing: RepoConfig[] = [
      {
        type: 'local',
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
      type: 'local',
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
        type: 'local',
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        type: 'ssh',
        id: 'repo-2',
        sshHost: 'dev-server',
        remotePath: '/home/beth/repos/other',
        name: 'other',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
    ];
    mockData.set('repos', existing);

    const updated: RepoConfig = {
      type: 'local',
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
        type: 'local',
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
        type: 'local',
        id: 'repo-1',
        path: '/home/beth/repos/yarr',
        name: 'yarr',
        model: 'opus',
        maxIterations: 40,
        completionSignal: 'ALL TODO ITEMS COMPLETE',
      },
      {
        type: 'ssh',
        id: 'repo-2',
        sshHost: 'dev-server',
        remotePath: '/home/beth/repos/other',
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
