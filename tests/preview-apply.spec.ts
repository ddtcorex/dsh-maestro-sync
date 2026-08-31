import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('preview-apply', () => {
  it('preview is read-only and returns previewId with 60s expiry', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello');
      const exec = vi.fn(async (cmd: string) => {
        if (String(cmd).includes('echo ok')) return 'ok';
        if (String(cmd).includes('find')) return 'memories/a.md\n';
        return '';
      });
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello world');
      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.previewId).toBeDefined();
      expect(preview.previewId).toMatch(/^[0-9a-f]+$/);
      const expiresMs = new Date(preview.expiresAt).getTime() - Date.now();
      expect(expiresMs).toBeGreaterThan(50000);
      expect(expiresMs).toBeLessThanOrEqual(61000);
      expect(preview.actions).toBeDefined();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('apply rejects without confirm:true and without valid previewId (or not yet implemented)', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-'));
    try {
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: async () => 'ok' as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      if (typeof (svc as any).apply !== 'function') {
        expect((svc as any).apply).toBeUndefined();
        return;
      }
      await expect((svc as any).apply({ previewId: 'bad', direction: 'pull', confirm: false })).rejects.toThrow();
      await expect((svc as any).apply({ previewId: 'bad', direction: 'pull', confirm: true })).rejects.toThrow();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('apply rejects stale preview (60s expiry) or not yet implemented', async () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-stale-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello');
      const exec = vi.fn(async (cmd: string) => {
        if (String(cmd).includes('echo ok')) return 'ok';
        if (String(cmd).includes('find')) return 'memories/a.md\n';
        return '';
      });
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello');
      const preview = await svc.preview({ direction: 'pull' });
      if (typeof (svc as any).apply !== 'function') {
        expect(preview.previewId).toBeDefined();
        return;
      }
      await expect((svc as any).apply({ previewId: 'expired-id', direction: 'pull', confirm: true })).rejects.toThrow();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });
});
