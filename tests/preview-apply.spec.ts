import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';
import { clearPreviews } from '../src/host/sync-plan.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('preview/apply RPC', () => {
  beforeEach(() => clearPreviews());

  it('preview is read-only and returns previewId with 60s expiry', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('echo ok')) return 'ok';
      return '';
    });
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-apply-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello\n');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello\n');
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      const copySpy = vi.fn();
      (svc as any).copyRemoteFiles = copySpy;
      const backupSpy = vi.fn();
      (svc as any).atomicWriteWithBackup = backupSpy;

      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.previewId).toBeDefined();
      expect(typeof preview.previewId).toBe('string');
      expect(preview.previewId).toMatch(/^[0-9a-f]{16,}$/);
      expect(preview.expiresAt).toBeDefined();
      expect(new Date(preview.expiresAt).getTime() - Date.now()).toBeGreaterThan(50000);
      expect(new Date(preview.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(61000);
      expect(preview.revision).toBeDefined();
      expect(Array.isArray(preview.actions)).toBe(true);
      expect(preview.summary).toBeDefined();
      expect(copySpy).not.toHaveBeenCalled();
      expect(backupSpy).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('apply rejects without confirm:true and without valid previewId', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('echo ok')) return 'ok';
      return '';
    });
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-apply2-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello\n');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello\n§\nworld\n');

      const preview = await svc.preview({ direction: 'pull' });

      await expect(svc.apply({ previewId: 'bad', direction: 'pull', confirm: false as any })).rejects.toThrow();
      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: false as any })).rejects.toThrow();
      await expect(svc.apply({ previewId: 'bad', direction: 'pull', confirm: true })).rejects.toThrow();
      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).resolves.toBeDefined();
      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toThrow();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('apply rejects stale preview (60s expiry)', async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (String(cmd).includes('echo ok')) return 'ok';
      return '';
    });
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-apply3-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello\n');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello\n');

      const preview = await svc.preview({ direction: 'pull' });

      const realNow = Date.now;
      try {
        const future = new Date(preview.expiresAt).getTime() + 1000;
        Date.now = (() => future) as any;
        await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toThrow();
      } finally {
        Date.now = realNow;
      }
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('apply rejects when direction mismatches preview', async () => {
    const exec = vi.fn(async () => 'ok');
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-apply4-'));
    try {
      fs.mkdirSync(path.join(localRoot, 'memories'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, 'memories', 'a.md'), 'hello\n');
      const svc = new SyncService({ localDsh: localRoot, remote: 'host', remoteDsh: '/home/kai/.dsh', exec: exec as any, fs: fs as any });
      vi.spyOn(svc, 'checkConnection').mockResolvedValue({ ok: true, host: 'host', latencyMs: 1 } as any);
      vi.spyOn(svc, 'listLocalFiles').mockReturnValue(['memories/a.md']);
      vi.spyOn(svc, 'listRemoteFiles').mockResolvedValue(['memories/a.md']);
      vi.spyOn(svc as any, 'fetchRemoteFile').mockResolvedValue('hello\n');
      const preview = await svc.preview({ direction: 'pull' });
      await expect(svc.apply({ previewId: preview.previewId, direction: 'push', confirm: true })).rejects.toThrow();
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
  });

  it('RPC exposes preview and apply via loopback channel', async () => {
    const { default: plugin, RPC_CHANNEL } = await import('../src/host/index.js');
    expect(RPC_CHANNEL).toBe('/dsh-maestro-sync');
    expect(plugin.inject).toEqual(expect.arrayContaining(['tools', 'connection']));

    const register = vi.fn(() => () => {});
    let rpcHandler: any = null;
    const handle = vi.fn((channel: string, handler: any, opts: any) => {
      rpcHandler = handler;
      expect(channel).toBe('/dsh-maestro-sync');
      expect(opts).toEqual({ authority: 'loopback' });
      return () => {};
    });
    const effect = vi.fn((fn: any) => fn());
    const ctx: any = { effect, tools: { register }, connection: { rpc: { handle } }, on: vi.fn(() => () => {}) };
    await plugin.apply(ctx);
    expect(typeof rpcHandler).toBe('function');

    const fakePreview = { previewId: 'abc123abc123abc1', expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 'rev', actions: [], summary: { copied: 0, merged: 0, skipped: 0, conflicts: 0, added: 0 } };
    const previewSpy = vi.spyOn(SyncService.prototype, 'preview').mockResolvedValue(fakePreview as any);
    const applySpy = vi.spyOn(SyncService.prototype, 'apply').mockResolvedValue({ ok: true, summary: fakePreview.summary, committed: [], failures: [] } as any);
    vi.spyOn(SyncService.prototype, 'status').mockResolvedValue({ localOnly: 0, remoteOnly: 0, both: 0, localOnlyFiles: [], remoteOnlyFiles: [], bothFiles: [] } as any);
    vi.spyOn(SyncService.prototype, 'pull').mockResolvedValue({ copied: 0, merged: 0, added: 0 } as any);
    vi.spyOn(SyncService.prototype, 'push').mockResolvedValue({ copied: 0, merged: 0, added: 0 } as any);
    vi.spyOn(SyncService.prototype, 'checkConnection').mockResolvedValue({ ok: true, host: 'host' } as any);

    const resPreview = await rpcHandler('preview', { direction: 'pull' });
    expect(previewSpy).toHaveBeenCalledWith({ direction: 'pull' });
    expect(resPreview.ok).toBe(true);
    expect(resPreview.previewId).toBeDefined();

    const resApply = await rpcHandler('apply', { previewId: fakePreview.previewId, direction: 'pull', confirm: true });
    expect(applySpy).toHaveBeenCalledWith({ previewId: fakePreview.previewId, direction: 'pull', confirm: true });
    expect(resApply.ok).toBe(true);

    const resApplyBad = await rpcHandler('apply', { previewId: fakePreview.previewId, direction: 'pull', confirm: false });
    expect(resApplyBad.ok).toBe(false);

    const resUnknown = await rpcHandler('unknown', {});
    expect(resUnknown.ok).toBe(false);

    vi.restoreAllMocks();
  });
});
