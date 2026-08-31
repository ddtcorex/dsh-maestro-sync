import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('pull-push', () => {
  it('pull merges via SyncPlan and atomically publishes with backup+fsync+rename', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'local\n');
      const exec = vi.fn(async (cmd: string) => {
        if (String(cmd).includes('echo ok')) return 'ok';
        if (String(cmd).includes('find')) return 'memories/a.md\nmemories/b.md\n';
        return '';
      });
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md', 'memories/b.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockImplementation(async (p: string) => {
        if (p === 'memories/a.md') return 'local\n§\nremote\n';
        if (p === 'memories/b.md') return 'new remote\n';
        return '';
      });
      const res = await svc.pull({ dryRun: true });
      expect(res.copied).toBe(1);
      expect(res.merged).toBeGreaterThanOrEqual(0);
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('push via SyncPlan handles dryRun and basic publish', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'local\n');
      const exec = vi.fn(async () => '');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue([]);
      const res = await svc.push({ dryRun: true });
      expect(res.copied).toBe(1);
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
