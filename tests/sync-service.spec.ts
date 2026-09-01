import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { createFakeRemote, makeTempRoots } from './helpers/fake-transport.js';

const MD = 'memories/daily/2026-08-29.md';
const SESSION = 'sessions/abc123/def456/session.jsonl.zstd';

beforeEach(() => clearPreviews());

const stubRunner: any = {
  run: vi.fn(async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 })),
};

describe('SyncService', () => {
  it('status partitions by path only and never implies content equality', async () => {
    const { localRoot, cleanup } = makeTempRoots('status-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nlocal\n');
      // same path exists remotely with different content -> both, not "in sync"
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nremote\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const st = await svc.status();
      expect(st.both).toBe(1);
      expect(st.localOnly).toBe(0);
      expect(st.remoteOnly).toBe(0);
      expect(st.localOnlyFiles).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('statusPage paginates with a cursor and bounded page size', async () => {
    const { localRoot, cleanup } = makeTempRoots('page-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(localRoot, `memories/daily/2026-08-01-${String(i).padStart(2, '0')}.md`), `day ${i}\n`);
      const fake = createFakeRemote();
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const page1 = await svc.statusPage({ bucket: 'localOnly', cursor: 0, limit: 5 });
      expect(page1.total).toBe(12);
      expect(page1.files.length).toBe(5);
      expect(page1.nextCursor).toBe(5);
      const page2 = await svc.statusPage({ bucket: 'localOnly', cursor: page1.nextCursor!, limit: 5 });
      expect(page2.files.length).toBe(5);
      expect(page2.nextCursor).toBe(10);
      const page3 = await svc.statusPage({ bucket: 'localOnly', cursor: page2.nextCursor!, limit: 5 });
      expect(page3.files.length).toBe(2);
      expect(page3.nextCursor).toBeNull();
      // pages are disjoint
      const seen = new Set([...page1.files, ...page2.files, ...page3.files]);
      expect(seen.size).toBe(12);
      // small JSON page (RPC-safe)
      expect(JSON.stringify(page1).length).toBeLessThan(64 * 1024);
    } finally {
      cleanup();
    }
  });

  it('stages only change candidates: identical bytes are never transferred', async () => {
    const { localRoot, cleanup } = makeTempRoots('diffstage-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'shared.md'), 'identical\n');
      // remote: one identical file and one divergent file
      const fake = createFakeRemote(
        new Map<string, Buffer>([
          ['memories/shared.md', Buffer.from('identical\n')],
          ['memories/daily/2026-08-29.md', Buffer.from('a\n§\nremote\n')],
        ]),
      );
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.actions.find((a: any) => a.path === 'memories/shared.md')!.action).toBe('skip');
      expect(preview.actions.find((a: any) => a.path === 'memories/daily/2026-08-29.md')!.action).toBe('copy');
      // only the divergent file was staged
      expect(fake.calls.stage.length).toBe(1);
      expect(fake.calls.stage[0]!.paths).toEqual(['memories/daily/2026-08-29.md']);
    } finally {
      cleanup();
    }
  });

  it('resolveTarget resolves a ~/.dsh placeholder via transport preflight to an absolute path', async () => {
    const fake = createFakeRemote();
    const svc = new SyncService({
      localDsh: '/tmp/a',
      remote: 'sync-host',
      remoteDsh: '~/.dsh',
      fs: fs as any,
      runner: stubRunner as any,
      transport: fake.transport as any,
    });
    const target = await svc.resolveTarget();
    expect(target.host).toBe('sync-host');
    expect(target.dshRoot).toBe('/home/kai/.dsh');
  });

  it('preview while offline throws a structured OFFLINE failure', async () => {
    const { localRoot, cleanup } = makeTempRoots('offline-');
    try {
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: { run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('Connection refused'), exitCode: 255 })) } as any,
        transport: createFakeRemote().transport as any,
      });
      await expect(svc.preview({ direction: 'pull' })).rejects.toMatchObject({ phase: 'validate', code: 'OFFLINE' });
    } finally {
      cleanup();
    }
  });

  it('eligibility: only memory md, SUGGESTIONS.jsonl and session zstd are snapshotted', async () => {
    const { localRoot, cleanup } = makeTempRoots('eligible-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.mkdirSync(path.join(localRoot, 'sessions', 'abc123', 'def456'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'daily', '2026-08-29.md'), 'a\n§\nlocal\n');
      fs.writeFileSync(path.join(localRoot, 'memories', 'SUGGESTIONS.jsonl'), '{"s":1}\n');
      fs.writeFileSync(path.join(localRoot, SESSION), 'not-real-zstd-bytes');
      // excluded files exist but must never be read/hashed
      fs.writeFileSync(path.join(localRoot, 'memories', 'daily', '2026-08-29.md.bak.1720000000.aa'), 'backup bytes');
      fs.mkdirSync(path.join(localRoot, 'profiles', 'web'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'profiles', 'web', 'package.json'), '{"private":true}');
      fs.writeFileSync(path.join(localRoot, 'settings.json'), '{"secret":true}');

      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nlocal\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const preview = await svc.preview({ direction: 'pull' });
      // only the md + jsonl + session are considered; .bak.* / profiles / settings are excluded
      const paths = preview.actions.map((a: any) => a.path);
      expect(paths).toContain('memories/daily/2026-08-29.md');
      expect(paths).toContain('memories/SUGGESTIONS.jsonl');
      expect(paths).toContain(SESSION);
      expect(paths.some((p: string) => p.includes('.bak.') || p.startsWith('profiles/') || p === 'settings.json')).toBe(false);
      // SUGGESTIONS.jsonl and the session zstd are identical -> skip; the md differs -> merge
      expect(preview.actions.find((a: any) => a.path === MD).action).toBe('skip');
    } finally {
      cleanup();
    }
  });
});