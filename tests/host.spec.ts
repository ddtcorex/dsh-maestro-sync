import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';
import { SshRsyncTransport } from '../src/host/transport.js';

async function bootPlugin(extra: any = {}) {
  const register = vi.fn(() => () => {});
  let rpcHandler: any = null;
  const handle = vi.fn((channel: string, handler: any, opts: any) => {
    rpcHandler = handler;
    return () => {};
  });
  const effect = vi.fn((fn: any) => {
    try {
      const res = fn();
      return typeof res === 'function' ? res : () => {};
    } catch {
      return () => {};
    }
  });
  const ctx: any = { effect, tools: { register }, connection: { rpc: { handle } }, on: vi.fn(() => () => {}), ...extra };
  const mod: any = await import('../src/host/index.js');
  const plugin: any = mod.default ?? mod;
  await plugin.apply(ctx);
  return { register, handle, rpcHandler, plugin, mod };
}

describe('host', () => {
  it('registers five complete tool definitions and the loopback RPC channel', async () => {
    const { register, handle, plugin } = await bootPlugin();
    expect(plugin.inject).toEqual(expect.arrayContaining(['tools', 'connection']));
    expect(register.mock.calls.length).toBeGreaterThanOrEqual(11); // 5 sync tools + 6 backup/restore/gc tools
    expect(register.mock.calls.every((call: any[]) => call.length === 1)).toBe(true);
    const definitions = register.mock.calls.map((call: any[]) => call[0]);
    const names = definitions.map((definition: any) => definition.name);
    expect(names).toEqual(
      expect.arrayContaining(['maestro_sync_preview', 'maestro_sync_apply', 'maestro_sync_pull', 'maestro_sync_push', 'maestro_sync_status', 'maestro_backup_preview', 'maestro_backup_apply', 'maestro_restore_preview', 'maestro_restore_apply', 'maestro_backup_gc_preview', 'maestro_backup_gc_apply']),
    );
    for (const definition of definitions) {
      expect(definition.parameters).toMatchObject({ type: 'object' });
      expect(definition.output).toMatchObject({
        schema: { type: 'object' },
        render: expect.any(Function),
      });
      expect(definition.output.render({}, { text: '{"ok":true}' })).toEqual([{ type: 'text', text: '{"ok":true}' }]);
    }
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith('/dsh-maestro-sync', expect.any(Function), { authority: 'loopback' });
  });

  it('legacy pull/push RPC are preview-only: no dryRun can apply, apply is never implied', async () => {
    const { rpcHandler } = await bootPlugin();
    const previewSpy = vi.spyOn(SyncService.prototype, 'preview').mockResolvedValue({
      previewId: 'x'.repeat(32),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revision: 'r',
      actions: [],
      summary: { copied: 0, merged: 0, skipped: 0, conflicts: 0, added: 0 },
    } as any);
    const applySpy = vi.spyOn(SyncService.prototype, 'apply').mockResolvedValue({ ok: true, revision: 'r', summary: {} as any, committed: [], failures: [] } as any);

    // omitted dryRun must still be preview-only
    const resPull = await rpcHandler('pull', {});
    expect(resPull.ok).toBe(true);
    expect(previewSpy).toHaveBeenCalledWith({ direction: 'pull' });
    const resPush = await rpcHandler('push', { dryRun: false });
    expect(resPush.ok).toBe(true);
    expect(previewSpy).toHaveBeenCalledWith({ direction: 'push' });
    expect(applySpy).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('status RPC pages with cursor and stays bounded', async () => {
    const files = Array.from({ length: 25 }, (_, i) => `dsh-maestro-memory/daily/2026-08-${String(i + 1).padStart(2, '0')}.md`);
    vi.spyOn(SyncService.prototype, 'statusPage').mockResolvedValue({
      total: 25,
      offset: 0,
      limit: 5,
      files: files.slice(0, 5),
      nextCursor: 5,
      connection: { ok: true, host: 'h' },
      remoteHost: 'h',
    } as any);
    const { rpcHandler } = await bootPlugin();
    const res = await rpcHandler('status', { bucket: 'localOnly', cursor: 0, limit: 5 });
    expect(res.ok).toBe(true);
    const page = res.value;
    expect(page.nextCursor).toBe(5);
    expect(page.files.length).toBe(5);
    expect(JSON.stringify(page).length).toBeLessThan(64 * 1024);
    vi.restoreAllMocks();
  });

  it('apply RPC returns a structured failure instead of throwing', async () => {
    const { rpcHandler } = await bootPlugin();
    vi.spyOn(SyncService.prototype, 'apply').mockRejectedValue(Object.assign(new Error('preview not found or expired (60s)'), { code: 'STALE_PREVIEW', phase: 'validate' }));
    const res = await rpcHandler('apply', { previewId: 'bad', direction: 'pull', confirm: true });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('STALE_PREVIEW');
    expect(res.error.details.phase).toBe('validate');
    vi.restoreAllMocks();
  });

  it('has correct inject array and RPC channel export', async () => {
    const { plugin, mod } = await bootPlugin();
    expect(plugin.inject).toContain('tools');
    expect(plugin.inject).toContain('connection');
    expect(mod.RPC_CHANNEL).toBe('/dsh-maestro-sync');
  });

  it('registers bidirectional preview/apply tools with the maestro_sync_ prefix', async () => {
    const { register } = await bootPlugin();
    const names = register.mock.calls.map((call: any[]) => call[0].name);
    expect(names).toContain('maestro_sync_bidirectional_preview');
    expect(names).toContain('maestro_sync_bidirectional_apply');
  });

  it('bidirectional apply tool refuses without confirm:true and never writes', async () => {
    const { register } = await bootPlugin();
    const applySpy = vi.spyOn(SyncService.prototype, 'apply');
    try {
      const def = register.mock.calls.map((call: any[]) => call[0]).find((d: any) => d.name === 'maestro_sync_bidirectional_apply');
      const res = JSON.parse((await def.execute({ previewId: 'x'.repeat(32) })).text);
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/confirm/);
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
    }
  });

  it('bidirectionalPreview RPC returns exact push plus projected pull', async () => {
    const { rpcHandler } = await bootPlugin();
    const summary = { copied: 0, merged: 1, skipped: 0, conflicts: 0, added: 1 };
    const previewSpy = vi.spyOn(SyncService.prototype, 'preview').mockImplementation(async ({ direction }: any) => ({
      previewId: `pv-${direction}`,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      revision: 'r',
      actions: [],
      summary,
      connection: { ok: true, host: 'h' },
      remoteHost: 'h',
    }) as any);
    try {
      const res = await rpcHandler('bidirectionalPreview', {});
      expect(res.ok).toBe(true);
      expect(res.value.push).toBeTruthy();
      expect(res.value.pullProjected).toBeTruthy();
      expect(previewSpy).toHaveBeenCalledWith(expect.objectContaining({ direction: 'push', scope: 'memory' }));
      const resSessions = await rpcHandler('bidirectionalPreview', { includeSessions: true });
      expect(resSessions.ok).toBe(true);
      expect(previewSpy).toHaveBeenCalledWith(expect.objectContaining({ direction: 'push', scope: 'all' }));
    } finally {
      previewSpy.mockRestore();
    }
  });

  it('bidirectionalApply RPC requires confirm:true and previewId', async () => {
    const { rpcHandler } = await bootPlugin();
    const applySpy = vi.spyOn(SyncService.prototype, 'apply');
    try {
      const noConfirm = await rpcHandler('bidirectionalApply', { previewId: 'x'.repeat(32) });
      expect(noConfirm.ok).toBe(false);
      const noId = await rpcHandler('bidirectionalApply', { confirm: true });
      expect(noId.ok).toBe(false);
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
    }
  });

  it('previewCancel errors on an unknown job and cancels a running job', async () => {
    const { rpcHandler } = await bootPlugin();
    const missing = await rpcHandler('previewCancel', { jobId: 'deadbeef' });
    expect(missing).toEqual({ ok: false, error: { code: 'maestro-sync/preview-job', message: 'preview job not found', details: {} } });

    const hang = new Promise(() => {});
    const previewSpy = vi.spyOn(SyncService.prototype, 'preview').mockImplementation(async () => {
      await hang;
      return {} as any;
    });
    try {
      const started = await rpcHandler('previewStart', { direction: 'pull' });
      const jobId = started.value.jobId;
      const cancel = await rpcHandler('previewCancel', { jobId });
      expect(cancel).toEqual({ ok: true, value: { ok: true } });
      const st = await rpcHandler('previewStatus', { jobId });
      expect(st.value.status).toBe('cancelled');
    } finally {
      previewSpy.mockRestore();
    }
  });

  it('getRemoteConfig reports the effective host and source without a connection check', async () => {
    const checkSpy = vi.spyOn(SyncService.prototype, 'checkConnection');
    try {
      const { rpcHandler } = await bootPlugin();
      const res = await rpcHandler('getRemoteConfig', {});
      expect(res.ok).toBe(true);
      expect(typeof res.value.remoteHost).toBe('string');
      expect(res.value.remoteHost.length).toBeGreaterThan(0);
      expect(['settings', 'env', 'default']).toContain(res.value.source);
      expect(checkSpy).not.toHaveBeenCalled();
    } finally {
      checkSpy.mockRestore();
    }
  });

  it('saveRemoteHost persists a valid host and rejects shell metachars', async () => {
    const { rpcHandler } = await bootPlugin();
    const bad = await rpcHandler('saveRemoteHost', { host: 'x; rm -rf ~' });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe('INVALID_HOST');
    const empty = await rpcHandler('saveRemoteHost', {});
    expect(empty.ok).toBe(false);
    expect(empty.error.code).toBe('INVALID_HOST');

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'sync-save-host-'));
    try {
      const good = await rpcHandler('saveRemoteHost', { host: 'kai@ssh.example.com' });
      expect(good).toEqual({ ok: true, value: { remoteHost: 'kai@ssh.example.com', scope: 'machine' } });
      const cfg = await rpcHandler('getRemoteConfig', {});
      // Saving also records this machine's own peer file, which outranks the
      // shared store the same save wrote: that store travels between machines,
      // so on the mirrored machine it can name that machine instead of its peer.
      expect(cfg.value).toMatchObject({ remoteHost: 'kai@ssh.example.com', source: 'machine' });
      const { readFileSync } = await import('node:fs');
      const peer = JSON.parse(readFileSync(join(process.env.DSH_HOME!, 'dsh-maestro-sync', 'peer.json'), 'utf-8'));
      expect(peer.remoteHost).toBe('kai@ssh.example.com');
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });

  it('saveR2Config persists a valid target and rejects bad fields', async () => {
    const { rpcHandler } = await bootPlugin();
    const badBucket = await rpcHandler('saveR2Config', { provider: 'r2', bucket: 'UPPER', prefix: 'p/' });
    expect(badBucket.ok).toBe(false);
    expect(badBucket.error.code).toBe('INVALID_R2_CONFIG');
    const missing = await rpcHandler('saveR2Config', { provider: 'r2', prefix: 'p/' });
    expect(missing.ok).toBe(false);

    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'sync-save-r2-'));
    try {
      const good = await rpcHandler('saveR2Config', { provider: 'r2', accountId: '', endpoint: '', region: 'auto', bucket: 'maestro-backup', prefix: 'v1/hosts/t' });
      expect(good.ok).toBe(true);
      expect(good.value.r2).toMatchObject({ provider: 'r2', bucket: 'maestro-backup', prefix: 'v1/hosts/t/' });
      const { load } = await import('@ddtcorex/dsh-maestro-config-lib');
      const doc: any = await load({ dshHome: process.env.DSH_HOME });
      expect(doc.domains.sync.r2).toMatchObject({ bucket: 'maestro-backup', prefix: 'v1/hosts/t/' });
      expect(JSON.stringify(doc.domains.sync.r2)).not.toContain('secret');
    } finally {
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });

  it('registers check_machines and tunnel_restore tools', async () => {
    const { register } = await bootPlugin();
    const names = register.mock.calls.map((call: any[]) => call[0].name);
    expect(names).toContain('maestro_sync_check_machines');
    expect(names).toContain('maestro_sync_tunnel_restore');
  });

  it('checkMachines RPC returns ids without side effects', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const prevHome = process.env.DSH_HOME;
    const home = mkdtempSync(join(tmpdir(), 'sync-machines-'));
    writeFileSync(join(home, 'machine-id'), 'machine-a\n');
    process.env.DSH_HOME = home;
    const targetSpy = vi.spyOn(SyncService.prototype, 'resolveTarget').mockResolvedValue({ host: 'sync-host', dshRoot: '/home/kai/.dsh' });
    const idSpy = vi.spyOn(SshRsyncTransport.prototype, 'readMachineId').mockResolvedValue('machine-b');
    try {
      const { rpcHandler } = await bootPlugin();
      const res = await rpcHandler('checkMachines', { from: 'machine-a', to: 'machine-b' });
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({ ok: true, localId: 'machine-a', remoteId: 'machine-b' });
    } finally {
      targetSpy.mockRestore();
      idSpy.mockRestore();
      if (prevHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = prevHome;
    }
  });

  it('tunnelRestore RPC requires confirm:true', async () => {
    const { rpcHandler } = await bootPlugin();
    const res = await rpcHandler('tunnelRestore', { side: 'local' });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('maestro-sync/confirm');
  });
});
