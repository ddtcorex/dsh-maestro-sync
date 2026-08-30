import { describe, it, expect, vi } from 'vitest';
import { SyncService } from '../src/host/sync-service.js';

describe('host', () => {
  it('registers 3 tools and loopback RPC channel', async () => {
    const register = vi.fn(() => () => {});
    const handle = vi.fn(() => () => {});
    const effect = vi.fn((fn: any) => {
      try {
        const res = fn();
        return typeof res === 'function' ? res : () => {};
      } catch {
        return () => {};
      }
    });
    const on = vi.fn(() => () => {});
    const ctx: any = {
      effect,
      tools: { register },
      connection: { rpc: { handle } },
      on,
    };

    const mod: any = await import('../src/host/index.js');
    const plugin: any = mod.default ?? mod;
    expect(plugin.inject).toEqual(expect.arrayContaining(['tools', 'connection']));
    await plugin.apply(ctx);

    // Expect 3 tools: pull/push/status
    expect(register).toHaveBeenCalledTimes(3);
    const names = register.mock.calls.map((c: any[]) => String(c[0]));
    expect(names).toEqual(expect.arrayContaining(['maestro_sync_pull', 'maestro_sync_push', 'maestro_sync_status']));

    // RPC loopback
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith('/dsh-maestro-sync', expect.any(Function), { authority: 'loopback' });
  });

  it('exposes RPC handler dispatch for pull/push/status', async () => {
    // Mock SyncService methods to avoid real SSH/fs
    vi.spyOn(SyncService.prototype, 'status').mockResolvedValue({ localOnly: 0, remoteOnly: 0, both: 0, localOnlyFiles: [], remoteOnlyFiles: [], bothFiles: [] } as any);
    vi.spyOn(SyncService.prototype, 'pull').mockResolvedValue({ copied: 0, merged: 0, added: 0 } as any);
    vi.spyOn(SyncService.prototype, 'push').mockResolvedValue({ copied: 0, merged: 0, added: 0 } as any);

    const register = vi.fn(() => () => {});
    let rpcHandler: any = null;
    const handle = vi.fn((channel: string, handler: any, opts: any) => {
      rpcHandler = handler;
      return () => {};
    });
    const effect = vi.fn((fn: any) => fn());
    const ctx: any = {
      effect,
      tools: { register },
      connection: { rpc: { handle } },
      on: vi.fn(() => () => {}),
    };
    const mod: any = await import('../src/host/index.js');
    const plugin: any = mod.default ?? mod;
    await plugin.apply(ctx);
    expect(typeof rpcHandler).toBe('function');
    // dispatcher should handle known methods without throwing
    const resStatus = await rpcHandler('status', {});
    expect(resStatus).toBeDefined();
    expect(resStatus.ok).toBe(true);
    const resPull = await rpcHandler('pull', { dryRun: true });
    expect(resPull.ok).toBe(true);
    const resPush = await rpcHandler('push', { dryRun: true });
    expect(resPush.ok).toBe(true);
    const resUnknown = await rpcHandler('unknown', {});
    expect(resUnknown.ok).toBe(false);

    vi.restoreAllMocks();
  });

  it('has correct inject array and RPC channel export', async () => {
    const mod: any = await import('../src/host/index.js');
    const plugin: any = mod.default ?? mod;
    expect(plugin.inject).toContain('tools');
    expect(plugin.inject).toContain('connection');
    expect(mod.RPC_CHANNEL).toBe('/dsh-maestro-sync');
  });
});
