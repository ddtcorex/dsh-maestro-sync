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

describe('preview/apply contract', () => {
  it('preview is read-only and returns previewId with 60s expiry and exact actions', async () => {
    const { localRoot, cleanup } = makeTempRoots('preview-readonly-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      const localPath = path.join(localRoot, MD);
      fs.writeFileSync(localPath, 'a\n§\nfoo\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nfoo\n§\nbar\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      const preview = await svc.preview({ direction: 'pull' });
      expect(preview.previewId).toMatch(/^[0-9a-f]{32}$/);
      expect(new Date(preview.expiresAt).getTime() - Date.now()).toBeGreaterThan(50000);
      expect(preview.revision).toBeTruthy();
      const act = preview.actions.find((a: any) => a.path === MD)!;
      expect(act.action).toBe('merge');
      expect(act.added).toBe(1);
      expect(act.target).toBe('local');
      expect(preview.summary.merged).toBe(1);
      // preview staged remote bytes but never wrote to the live root
      expect(fs.readFileSync(localPath, 'utf-8')).toBe('a\n§\nfoo\n');
      expect(preview.connection.ok).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('apply rejects without confirm:true, without a valid previewId, and after expiry', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-guards-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nfoo\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nfoo\n§\nbar\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });

      await expect(svc.apply({ previewId: '', direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'INVALID_PREVIEW_ID' });
      await expect(svc.apply({ previewId: 'bad', direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });

      const preview = await svc.preview({ direction: 'pull' });
      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: false as any })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });

      // expiry
      const realNow = Date.now;
      try {
        Date.now = () => new Date(preview.expiresAt).getTime() + 1000;
        await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
      } finally {
        Date.now = realNow;
      }
    } finally {
      cleanup();
    }
  });

  it('apply rejects when direction mismatches the preview', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-dir-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nfoo\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nfoo\n§\nbar\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const preview = await svc.preview({ direction: 'pull' });
      await expect(svc.apply({ previewId: preview.previewId, direction: 'push', confirm: true })).rejects.toMatchObject({ code: 'DIRECTION_MISMATCH' });
    } finally {
      cleanup();
    }
  });

  it('a preview is single-use: a second apply with the same previewId is rejected', async () => {
    const { localRoot, cleanup } = makeTempRoots('apply-once-');
    try {
      fs.mkdirSync(path.join(localRoot, 'memories', 'daily'), { recursive: true });
      fs.writeFileSync(path.join(localRoot, MD), 'a\n§\nfoo\n');
      const fake = createFakeRemote(new Map([[MD, Buffer.from('a\n§\nfoo\n§\nbar\n')]]));
      const svc = new SyncService({
        localDsh: localRoot,
        remote: 'sync-host',
        remoteDsh: '/home/kai/.dsh',
        fs: fs as any,
        runner: stubRunner as any,
        transport: fake.transport as any,
      });
      const preview = await svc.preview({ direction: 'pull' });
      const first = await svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true });
      expect(first.ok).toBe(true);
      await expect(svc.apply({ previewId: preview.previewId, direction: 'pull', confirm: true })).rejects.toMatchObject({ code: 'STALE_PREVIEW' });
    } finally {
      cleanup();
    }
  });

  it('RPC exposes preview and apply via the loopback channel', async () => {
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

    const fakePreview = { previewId: 'a'.repeat(32), expiresAt: new Date(Date.now() + 60000).toISOString(), revision: 'rev', actions: [], summary: { copied: 0, merged: 0, skipped: 0, conflicts: 0, added: 0 } };
    const previewSpy = vi.spyOn(SyncService.prototype, 'preview').mockResolvedValue(fakePreview as any);
    const applySpy = vi.spyOn(SyncService.prototype, 'apply').mockResolvedValue({ ok: true, revision: 'rev', summary: fakePreview.summary, committed: [], failures: [] } as any);
    vi.spyOn(SyncService.prototype, 'status').mockResolvedValue({ localOnly: 0, remoteOnly: 0, both: 0, localOnlyFiles: [], remoteOnlyFiles: [], bothFiles: [], connection: { ok: true, host: 'h' }, remoteHost: 'h' } as any);
    vi.spyOn(SyncService.prototype, 'pull').mockResolvedValue({ copied: 0, merged: 0, added: 0, conflicts: 0 } as any);
    vi.spyOn(SyncService.prototype, 'push').mockResolvedValue({ copied: 0, merged: 0, added: 0, conflicts: 0 } as any);
    vi.spyOn(SyncService.prototype, 'checkConnection').mockResolvedValue({ ok: true, host: 'h' } as any);

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