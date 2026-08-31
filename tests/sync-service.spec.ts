import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';

describe('SyncService', () => {
  it('pull merges memories and returns copied/merged counts', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('find')) {
        return 'memories/daily/2026-08-29.md\nmemories/projects/new.md\nsessions/abc123/def456/session.jsonl.zstd\nsessions/xyz789/uvw012/session.jsonl.zstd\n';
      }
      if (String(cmd).includes('cat') && String(cmd).includes('daily')) {
        return 'foo\n§\nbar\n';
      }
      if (String(cmd).includes('cat') && String(cmd).includes('session.jsonl.zstd')) {
        return '{"seq":1}\n{"seq":2}\n';
      }
      if (String(cmd).includes('rsync')) return '';
      return '';
    });

    const readMock = vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('2026-08-29.md')) return 'a\n§\nfoo\n';
      if (s.includes('session.jsonl.zstd')) return '{"seq":1}\n';
      return '';
    });
    const writeMock = vi.fn();
    const copyMock = vi.fn();
    const existsMock = vi.fn(() => true);

    const fsMock: any = {
      readFileSync: readMock,
      writeFileSync: writeMock,
      copyFileSync: copyMock,
      existsSync: existsMock,
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false, isFile: () => true })),
      openSync: vi.fn(() => 1),
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
    };

    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'host',
      remoteDsh: '~/.dsh',
      exec: exec as any,
      fs: fsMock as any,
    });

    // mock file discovery to avoid real FS walk — use eligible paths
    vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md', 'sessions/abc123/def456/session.jsonl.zstd']);
    vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue([
      'memories/daily/2026-08-29.md',
      'memories/projects/new.md',
      'sessions/abc123/def456/session.jsonl.zstd',
      'sessions/xyz789/uvw012/session.jsonl.zstd',
    ]);

    const res = await svc.pull({ dryRun: false });
    expect(res.copied).toBe(2);
    expect(res.merged).toBeGreaterThanOrEqual(1);
    expect(res.added).toBeGreaterThanOrEqual(1);
    expect(res.conflicts).toBeDefined();
  });

  it('status without fetch returns partition counts', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('find')) {
        return 'memories/a.md\nmemories/b.md\n';
      }
      if (String(cmd).includes('echo ok')) return 'ok';
      return '';
    });
    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'host',
      remoteDsh: '~/.dsh',
      exec: exec as any,
    });
    vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
    vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md', 'memories/c.md']);
    vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md', 'memories/b.md']);

    const st = await svc.status();
    // status should not call cat/rsync, only find (via mocked lists)
    expect(st.both).toBe(1);
    expect(st.remoteOnly).toBe(1);
    expect(st.localOnly).toBe(1);
    // exec should not have been called with cat
    const catCalls = exec.mock.calls.filter(([c]) => String(c).includes('cat'));
    expect(catCalls.length).toBe(0);
  });

  it('pull dryRun does not write', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('find')) return 'memories/daily.md\n';
      if (String(cmd).includes('cat')) return 'foo\n§\nnew\n';
      return '';
    });
    const writeMock = vi.fn();
    const fsMock: any = {
      readFileSync: vi.fn(() => 'foo\n'),
      writeFileSync: writeMock,
      copyFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    };
    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'host',
      remoteDsh: '~/.dsh',
      exec: exec as any,
      fs: fsMock as any,
    });
    vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily.md']);
    vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily.md']);
    const res = await svc.pull({ dryRun: true });
    expect(writeMock).not.toHaveBeenCalled();
    expect(res.added).toBeGreaterThanOrEqual(0);
  });

  it('push returns copied/merged counts', async () => {
    const exec = vi.fn(async () => '');
    const readMock = vi.fn((p: string) => {
      const s = String(p);
      if (s.includes('a.md')) return 'content a';
      if (s.includes('local-only.md')) return 'local only';
      return '';
    });
    const fsMock: any = {
      readFileSync: readMock,
      writeFileSync: vi.fn(),
      copyFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      openSync: vi.fn(() => 1),
      fsyncSync: vi.fn(),
      closeSync: vi.fn(),
      rmSync: vi.fn(),
    };
    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'host',
      remoteDsh: '~/.dsh',
      exec: exec as any,
      fs: fsMock as any,
    });
    vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md', 'memories/daily/2026-08-30.md']);
    vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily/2026-08-29.md']);
    const res = await svc.push({ dryRun: true });
    expect(res.copied).toBe(1);
    expect(res.conflicts).toBeDefined();
  });

  it('listLocalFiles and listRemoteFiles are mockable', async () => {
    const exec = vi.fn(async () => 'memories/x.md\n');
    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'host',
      remoteDsh: '~/.dsh',
      exec: exec as any,
    });
    // default impl should be callable even without spy
    expect(typeof svc.listLocalFiles).toBe('function');
    expect(typeof svc.listRemoteFiles).toBe('function');
    const remoteFiles = await svc.listRemoteFiles();
    expect(Array.isArray(remoteFiles)).toBe(true);
  });
});
