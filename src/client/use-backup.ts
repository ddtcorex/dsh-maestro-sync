// src/client/use-backup.ts — R2 Sync tab controller (backup/restore/gc).
// Owns all R2-tab state: redacted status, backup preview job, restore modes,
// gc report, and the confirm dialog bound to a live preview id. Only shared
// presentation components are reused with the Remote tab — no shared state.
import * as React from 'react';
import { RPC_CHANNEL } from './ui.js';

export interface BackupStatusView {
  configured: boolean;
  source: 'env' | 'file' | 'none';
  bucket: string;
  prefix: string;
  lastManifest: string | null;
  eligible: { md: number; sessions: number };
}

export function useBackupTarget(ctx: any) {
  const [status, setStatus] = React.useState<BackupStatusView | null>(null);
  const [checking, setChecking] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [backupPreview, setBackupPreview] = React.useState<any>(null);
  const [restorePreview, setRestorePreview] = React.useState<any>(null);
  const [gcReport, setGcReport] = React.useState<any>(null);
  const [confirmOpen, setConfirmOpen] = React.useState<'backup' | 'restore' | 'gc' | null>(null);

  const call = React.useCallback(async (method: string, payload: any) => {
    const conn = (ctx as any).connection ?? (ctx as any).get?.('connection');
    const res: any = await conn.rpc.call(RPC_CHANNEL, method, payload);
    if (res && typeof res === 'object' && 'ok' in res) return res;
    return { ok: true, value: res };
  }, [ctx]);

  const loadStatus = React.useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const res = await call('backupStatus', {});
      if (res.ok) setStatus(res.value);
      else setError(res.error?.message ?? 'backup status failed');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setChecking(false);
    }
  }, [call]);

  const previewBackup = React.useCallback(async () => {
    setBusy(true);
    setError('');
    setBackupPreview(null);
    try {
      const res = await call('backupPreview', {});
      if (res.ok) {
        setBackupPreview(res.value);
        setConfirmOpen('backup');
      } else setError(res.error?.message ?? 'backup preview failed');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const applyBackup = React.useCallback(async () => {
    if (!backupPreview?.previewId) return;
    setBusy(true);
    try {
      const res = await call('backupApply', { previewId: backupPreview.previewId, confirm: true });
      setConfirmOpen(null);
      setBackupPreview(null);
      if (!res.ok) setError(res.error?.message ?? 'backup apply failed');
      void loadStatus();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [backupPreview, call, loadStatus]);

  const previewRestore = React.useCallback(
    async (mode: 'new-dir' | 'in-place') => {
      setBusy(true);
      setError('');
      try {
        const res = await call('restorePreview', { mode });
        if (res.ok) {
          setRestorePreview(res.value);
          setConfirmOpen('restore');
        } else setError(res.error?.message ?? 'restore preview failed');
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const applyRestore = React.useCallback(
    async (mode: 'new-dir' | 'in-place', destDir?: string) => {
      if (!restorePreview?.previewId) return;
      setBusy(true);
      try {
        const res = await call('restoreApply', { previewId: restorePreview.previewId, mode, destDir, confirm: true });
        setConfirmOpen(null);
        setRestorePreview(null);
        if (!res.ok) setError(res.error?.message ?? 'restore apply failed');
        if (mode === 'in-place') void loadStatus();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    },
    [restorePreview, call, loadStatus],
  );

  const previewGc = React.useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await call('backupGcPreview', {});
      if (res.ok) {
        setGcReport(res.value);
        setConfirmOpen('gc');
      } else setError(res.error?.message ?? 'gc preview failed');
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const applyGc = React.useCallback(async () => {
    if (!gcReport?.previewId) return;
    setBusy(true);
    try {
      const res = await call('backupGcApply', { previewId: gcReport.previewId, confirm: true });
      setConfirmOpen(null);
      setGcReport(null);
      if (!res.ok) setError(res.error?.message ?? 'gc apply failed');
      void loadStatus();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [gcReport, call, loadStatus]);

  const cancelDialog = React.useCallback(() => {
    setConfirmOpen(null);
    setBackupPreview(null);
    setRestorePreview(null);
    setGcReport(null);
  }, []);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const configured = status?.configured === true;
  return {
    status,
    checking,
    busy,
    error,
    backupPreview,
    restorePreview,
    gcReport,
    confirmOpen,
    canBackup: configured && !checking && !busy,
    loadStatus,
    previewBackup,
    applyBackup,
    previewRestore,
    applyRestore,
    previewGc,
    applyGc,
    cancelDialog,
  };
}