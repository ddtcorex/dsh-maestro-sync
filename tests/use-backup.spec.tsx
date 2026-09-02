// @vitest-environment jsdom
// tests/use-backup.spec.tsx — R2-tab controller (backup/restore/gc flows).
import { describe, it, expect } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useBackupTarget } from '../src/client/use-backup.js';

function makeCtx(handler: (method: string, payload: any) => Promise<any>) {
  return { connection: { rpc: { call: async (_ch: string, method: string, payload: any) => handler(method, payload) } } };
}

describe('useBackupTarget', () => {
  it('loads a redacted status and never exposes secret material', async () => {
    const ctx = makeCtx(async (method: string) => {
      if (method === 'backupStatus') {
        return { ok: true, value: { configured: true, source: 'env', bucket: 'maestro-backup', prefix: 'v1/hosts/abc/', lastManifest: '2026-09-02T00:00:00.000Z', eligible: { md: 59, sessions: 919 } } };
      }
      throw new Error('unexpected ' + method);
    });
    const { result } = renderHook(() => useBackupTarget(ctx));
    await waitFor(() => expect(result.current.status?.configured).toBe(true));
    const serialized = JSON.stringify(result.current.status);
    expect(serialized).not.toContain('accessKeyId');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('ak');
  });

  it('previewBackup opens a backup confirmation bound to the preview id', async () => {
    const previewId = 'pv'.repeat(16);
    const ctx = makeCtx(async (method: string) => {
      if (method === 'backupStatus') return { ok: true, value: { configured: true, source: 'env', bucket: 'b', prefix: 'p/', lastManifest: null, eligible: { md: 1, sessions: 1 } } };
      if (method === 'backupPreview') return { ok: true, value: { previewId, summary: { identical: 5, missing: 2, addedBytes: 100 } } };
      throw new Error('unexpected ' + method);
    });
    const { result } = renderHook(() => useBackupTarget(ctx));
    await act(async () => {
      await result.current.previewBackup();
    });
    expect(result.current.backupPreview?.previewId).toBe(previewId);
    expect(result.current.confirmOpen).toBe('backup');
  });

  it('applyBackup calls backupApply with confirm:true and the bound preview id', async () => {
    const previewId = 'pv'.repeat(16);
    let applied: any = null;
    const ctx = makeCtx(async (method: string, payload: any) => {
      if (method === 'backupStatus') return { ok: true, value: { configured: true, source: 'env', bucket: 'b', prefix: 'p/', lastManifest: null, eligible: { md: 1, sessions: 1 } } };
      if (method === 'backupPreview') return { ok: true, value: { previewId, summary: { identical: 1, missing: 1, addedBytes: 10 } } };
      if (method === 'backupApply') {
        applied = payload;
        return { ok: true, value: { ok: true, committed: ['memories/a.md'], failures: [] } };
      }
      throw new Error('unexpected ' + method);
    });
    const { result } = renderHook(() => useBackupTarget(ctx));
    await act(async () => {
      await result.current.previewBackup();
    });
    await act(async () => {
      await result.current.applyBackup();
    });
    expect(applied).toEqual({ previewId, confirm: true });
    expect(result.current.confirmOpen).toBeNull();
  });

  it('surfaces the not-configured state and disables backup actions', async () => {
    const ctx = makeCtx(async (method: string) => {
      if (method === 'backupStatus') return { ok: true, value: { configured: false, source: 'none', bucket: '', prefix: '', lastManifest: null, eligible: { md: 0, sessions: 0 } } };
      throw new Error('unexpected ' + method);
    });
    const { result } = renderHook(() => useBackupTarget(ctx));
    await waitFor(() => expect(result.current.status?.configured).toBe(false));
    expect(result.current.status?.source).toBe('none');
    const r = result.current;
    expect(r.canBackup).toBe(false);
  });
});