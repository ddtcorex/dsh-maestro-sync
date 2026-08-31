import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('pull-push SyncPlan atomic', () => {
  it('pull merges via SyncPlan and atomically publishes with backup+fsync+rename', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-atomic-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const localPath = path.join(localRoot, 'memories', 'daily', '2026-08-29.md');
      fs.writeFileSync(localPath, 'a\n§\nfoo\n');

      let fsyncCalled = false;
      let backupCreated = false;
      let renameCalled = false;
      const origFs = fs as any;
      const fsMock: any = {
        ...origFs,
        copyFileSync: vi.fn((src: string, dest: string) => {
          backupCreated = true;
          return origFs.copyFileSync(src, dest);
        }),
        openSync: vi.fn((p: string, flags: string) => origFs.openSync(p, flags as any)),
        fsyncSync: vi.fn((fd: number) => {
          fsyncCalled = true;
          return origFs.fsyncSync(fd);
        }),
        closeSync: vi.fn((fd: number) => origFs.closeSync(fd)),
        renameSync: vi.fn((a: string, b: string) => {
          renameCalled = true;
          return origFs.renameSync(a, b);
        }),
        readFileSync: origFs.readFileSync.bind(origFs),
        writeFileSync: origFs.writeFileSync.bind(origFs),
        existsSync: origFs.existsSync.bind(origFs),
        mkdirSync: origFs.mkdirSync.bind(origFs),
        readdirSync: origFs.readdirSync.bind(origFs),
        statSync: origFs.statSync.bind(origFs),
        rmSync: origFs.rmSync.bind(origFs),
        unlinkSync: origFs.unlinkSync?.bind(origFs),
        chmodSync: origFs.chmodSync?.bind(origFs),
        readdir: origFs.readdir,
      };

      const runner = {
        run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })),
      };
      const stageMock = vi.fn(async (target: any, paths: readonly string[], dest: string) => {
        for (const rel of paths) {
          if (rel === 'memories/daily/2026-08-29.md') {
            const staged = path.join(dest, rel);
            fs.mkdirSync(path.dirname(staged), { recursive: true });
            fs.writeFileSync(staged, 'a\n§\nfoo\n§\nbar\n');
          }
        }
      });
      const transport = {
        list: vi.fn(async () => Buffer.from('')),
        stage: stageMock,
        upload: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        remoteHome: vi.fn(async () => '/home/kai'),
      };

      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fsMock,
        runner: runner as any,
        transport: transport as any,
      });
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily/2026-08-29.md']);

      const res = await svc.pull({ dryRun: false });
      expect(res.merged).toBe(1);
      expect(backupCreated).toBe(true);
      expect(fsyncCalled).toBe(true);
      expect(renameCalled).toBe(true);
      const final = fs.readFileSync(localPath, 'utf-8');
      expect(final).toContain('bar');
      expect(stageMock).toHaveBeenCalled();
      expect(res).toHaveProperty('conflicts');
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('push via SyncPlan returns non-zero on partial failure with journal', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'push-partial-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories/daily/2026-08-29.md'), 'a\n§\nlocal1\n');
      fs.writeFileSync(path.join(localRoot, 'memories/daily/2026-08-30.md'), 'b\n§\nlocal2\n');

      const runner = {
        run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })),
      };
      const stageMock = vi.fn(async (target: any, paths: readonly string[], dest: string) => {
        for (const rel of paths) {
          const staged = path.join(dest, rel);
          fs.mkdirSync(path.dirname(staged), { recursive: true });
          if (rel === 'memories/daily/2026-08-29.md') fs.writeFileSync(staged, 'a\n§\nremote1\n');
          if (rel === 'memories/daily/2026-08-30.md') fs.writeFileSync(staged, 'b\n§\nremote2\n');
        }
      });
      let uploadCall = 0;
      const uploadMock = vi.fn(async () => {
        uploadCall++;
        if (uploadCall === 2) throw Object.assign(new Error('upload failed'), { phase: 'publish', code: 'UPLOAD_FAILED' });
      });
      const transport = {
        list: vi.fn(async () => Buffer.from('')),
        stage: stageMock,
        upload: uploadMock,
        commit: vi.fn(async () => {}),
        remoteHome: vi.fn(async () => '/home/kai'),
      };

      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: runner as any,
        transport: transport as any,
      });
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md', 'memories/daily/2026-08-30.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily/2026-08-29.md', 'memories/daily/2026-08-30.md']);

      await expect(svc.push({ dryRun: false })).rejects.toMatchObject({ committed: expect.any(Array) });
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('dryRun does not write and returns plan without side effects', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'daily', '2026-08-29.md'), 'a\n§\nfoo\n');
      const runner = { run: vi.fn(async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 })) };
      const stageMock = vi.fn(async (target: any, paths: readonly string[], dest: string) => {
        for (const rel of paths) {
          const staged = path.join(dest, rel);
          fs.mkdirSync(path.dirname(staged), { recursive: true });
          fs.writeFileSync(staged, 'a\n§\nfoo\n§\nbar\n');
        }
      });
      const transport = {
        list: vi.fn(async () => Buffer.from('')),
        stage: stageMock,
        upload: vi.fn(async () => {}),
        commit: vi.fn(async () => {}),
        remoteHome: vi.fn(async () => '/home/kai'),
      };
      const writeSpy = vi.fn();
      const fsMock: any = {
        ...fs,
        writeFileSync: vi.fn((p: string, data: any) => {
          if (String(p).startsWith(localRoot) && !String(p).includes('.tmp.')) writeSpy(p, data);
          return fs.writeFileSync(p, data);
        }),
        readFileSync: fs.readFileSync.bind(fs),
        existsSync: fs.existsSync.bind(fs),
        mkdirSync: fs.mkdirSync.bind(fs),
        readdirSync: fs.readdirSync.bind(fs),
        statSync: fs.statSync.bind(fs),
        rmSync: fs.rmSync.bind(fs),
        copyFileSync: fs.copyFileSync.bind(fs),
        renameSync: fs.renameSync.bind(fs),
        openSync: (fs as any).openSync.bind(fs),
        fsyncSync: (fs as any).fsyncSync.bind(fs),
        closeSync: (fs as any).closeSync.bind(fs),
      };
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fsMock,
        runner: runner as any,
        transport: transport as any,
      });
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/daily/2026-08-29.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/daily/2026-08-29.md']);
      const res = await svc.pull({ dryRun: true });
      expect(writeSpy).not.toHaveBeenCalled();
      expect(res.merged).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
