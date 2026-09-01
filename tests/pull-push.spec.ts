/**
 * Legacy pull()/push() are preview-only compatibility aliases: they must never
 * write, back up, or publish — the only mutation route is apply(confirm:true).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import { createFakeRemote, makeTempRoots } from './helpers/fake-transport.js';

const MD = 'memories/daily/2026-08-29.md';

const stubRunner: any = {
  run: vi.fn(async () => ({ stdout: Buffer.from('ok'), stderr: Buffer.alloc(0), exitCode: 0 })),
};

beforeEach(() => clearPreviews());

describe('legacy pull/push compatibility', () => {
  it('pull() is preview-only even when dryRun is omitted — no local write', async () => {
    const { localRoot, cleanup } = makeTempRoots('legacy-pull-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const localPath = path.join(localRoot, MD);
      fs.writeFileSync(localPath, 'a\n§\nlocal1\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nremote1\n§\nremote2\n')]]));
      const writeSpy = vi.fn();
      const fsMock: any = {
        ...fs,
        writeFileSync: vi.fn((p: string, data: any) => {
          if (String(p).startsWith(localRoot)) writeSpy(p, data);
          return fs.writeFileSync(p, data);
        }),
      };
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fsMock,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const res = await svc.pull({ dryRun: false });
      expect(res.merged).toBe(1);
      expect(res.copied).toBe(0);
      // no write under the live root
      expect(writeSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('a\n§\nlocal1\n');
    } finally {
      cleanup();
    }
  });

  it('push() is preview-only even when dryRun is omitted — nothing is uploaded or committed', async () => {
    const { localRoot, cleanup } = makeTempRoots('legacy-push-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nentry-local\n');
      const remoteBytes = Buffer.from('a\n§\nentry-remote\n');
      const fake = createFakeRemote(new Map([[MD, remoteBytes]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const res = await svc.push({ dryRun: false });
      expect(res.merged).toBe(1);
      expect(fake.calls.upload.length).toBe(0);
      expect(fake.calls.commit.length).toBe(0);
      expect(fake.remote.get(MD)!.equals(remoteBytes)).toBe(true);
    } finally {
      cleanup();
    }
  });
});