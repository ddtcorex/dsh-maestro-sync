// @vitest-environment jsdom
/**
 * Client behavior (Task 7): Preview is a read-only exact plan; apply exists only
 * in a confirmation dialog bound to a live preview; cancel never applies; errors
 * are announced with role="alert"; long lists paginate with "Show more".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncPanel } from '../src/client/index.js';

const PREVIEW_ID = 'a'.repeat(32);

const summary = { copied: 1, merged: 1, skipped: 2, conflicts: 0, added: 1 };

function makePreview(actions: any[] = [
  { path: 'memories/daily/2026-08-29.md', action: 'merge', target: 'local', added: 1, reason: 'content differs' },
  { path: 'memories/projects/new.md', action: 'copy', target: 'local', added: 0, reason: 'remote only' },
]) {
  return {
    ok: true,
    previewId: PREVIEW_ID,
    revision: 'rev1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    actions,
    summary,
    connection: { ok: true, host: 'sync-host' },
    remoteHost: 'sync-host',
  };
}

function makeCtx(rpc: any) {
  return { connection: { rpc: { call: rpc } }, get: () => undefined as any };
}

const carrier = (value: any) => ({ ok: true, value });

/** Async preview flow: previewStart returns a jobId, previewStatus settles with the preview. */
const previewFlow = (settled: any, first: 'running' | 'done' = 'done') => ({
  'previewStart': () => carrier({ jobId: 'job1' }),
  'previewStatus': () =>
    first === 'running'
      ? carrier({ status: 'running', progress: { phase: 'hashing', current: 1, total: 2, file: 'sessions/abc/x.jsonl.zstd' } })
      : carrier({ status: 'done', preview: settled }),
})

function statusCalls(rpc: any) {
  return rpc.mock.calls.filter(([c]: any) => c === '/dsh-maestro-sync').map(([, m]: any) => m);
}

beforeEach(() => cleanup());

describe('SyncPanel', () => {
  it('Preview Pull opens a confirmation dialog with exact actions; no apply before confirmation', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 0, both: 0 });
      if (method === 'status') return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      const f = previewFlow(makePreview());
      if (method === 'previewStart') return f['previewStart']();
      if (method === 'previewStatus') return f['previewStatus']();
      if (method === 'apply') return carrier({ ok: true, revision: 'rev1', summary, committed: [], failures: [] });
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));

    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    await user.click(screen.getByTestId('sync-preview-pull'));

    // confirmation dialog names the plan and shows the merged file with its added count
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('2026-08-29.md');
    expect(dialog.textContent).toMatch(/1 new entry/);
    expect(dialog.textContent).toContain('sync-host');
    // apply is only inside the dialog; none happened yet
    const applyButtons = screen.getAllByRole('button', { name: /apply/i });
    expect(applyButtons.length).toBeGreaterThan(0);
    expect(statusCalls(rpc)).not.toContain('apply');
  });

  it('cancelling the confirmation applies nothing and closes the dialog', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 0, remoteOnly: 0, both: 0 });
      if (method === 'status') return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      const f = previewFlow(makePreview());
      if (method === 'previewStart') return f['previewStart']();
      if (method === 'previewStatus') return f['previewStatus']();
      if (method === 'apply') return carrier({ ok: true });
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    await user.click(screen.getByTestId('sync-preview-pull'));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(statusCalls(rpc)).not.toContain('apply');
  });

  it('confirming applies with {previewId, direction, confirm:true} and announces success in an aria-live region', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 0, remoteOnly: 0, both: 0 });
      if (method === 'status') return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      const f = previewFlow(makePreview());
      if (method === 'previewStart') return f['previewStart']();
      if (method === 'previewStatus') return f['previewStatus']();
      if (method === 'apply') return carrier({ ok: true, revision: 'rev1', summary, committed: ['memories/daily/2026-08-29.md'], failures: [] });
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    await user.click(screen.getByTestId('sync-preview-pull'));
    const dialog = await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /apply pull/i }));
    await waitFor(() => expect(statusCalls(rpc)).toContain('apply'));
    const applyArgs = rpc.mock.calls.find(([, m]: any) => m === 'apply')![2];
    expect(applyArgs).toMatchObject({ previewId: PREVIEW_ID, direction: 'pull', confirm: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // success is announced through an aria-live region
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('announces apply errors with role="alert" and keeps the dialog closed', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 0, remoteOnly: 0, both: 0 });
      if (method === 'status') return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      const f = previewFlow(makePreview());
      if (method === 'previewStart') return f['previewStart']();
      if (method === 'previewStatus') return f['previewStatus']();
      if (method === 'apply') return { ok: false, error: { code: 'STALE_PREVIEW', message: 'inventory changed since preview', details: {} } };
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    await user.click(screen.getByTestId('sync-preview-pull'));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: /apply pull/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('STALE_PREVIEW');
    // dialog closed after a failed apply
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a long preview action list paginates with Show more', async () => {
    const user = userEvent.setup();
    const actions = Array.from({ length: 12 }, (_, i) => ({ path: `memories/daily/2026-08-${String(i + 1).padStart(2, '0')}.md`, action: 'merge' as const, target: 'local' as const, added: 1, reason: 'content differs' }));
    const rpc = vi.fn(async (_ch: string, method: string, args: any) => {
      if (method === 'status' && !args?.bucket) return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 0, remoteOnly: 0, both: 0 });
      if (method === 'status') return carrier({ ok: true, total: 0, offset: 0, limit: 10, files: [], nextCursor: null, connection: { ok: true, host: 'sync-host' }, remoteHost: 'sync-host' });
      const f = previewFlow(makePreview(actions));
      if (method === 'previewStart') return f['previewStart']();
      if (method === 'previewStatus') return f['previewStatus']();
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx(rpc) }));
    await waitFor(() => expect(screen.getByTestId('sync-preview-pull')).toBeEnabled());
    await user.click(screen.getByTestId('sync-preview-pull'));
    const dialog = await screen.findByRole('dialog');
    // initial page shows 5 rows, then Show more reveals the rest
    const rowsBefore = dialog.querySelectorAll('[data-action-row]').length;
    expect(rowsBefore).toBe(5);
    await user.click(screen.getByRole('button', { name: /show more/i }));
    const rowsAfter = dialog.querySelectorAll('[data-action-row]').length;
    expect(rowsAfter).toBe(10);
  });

  it('R2 tab renders when selected; Remote tab keeps the preview buttons', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string) => {
      if (method === 'backupStatus') return carrier({ configured: true, source: 'env', bucket: 'maestro-backup', prefix: 'v1/hosts/t/', lastManifest: null, eligible: { md: 2, sessions: 3 } });
      if (method === 'status') return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 2, remoteOnly: 0, both: 0 });
      if (method === 'backupPreview') return carrier({ previewId: 'pv'.repeat(16), summary: { identical: 1, missing: 1, addedBytes: 10 } });
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx((_ch: string, m: string) => rpc(_ch, m)) as any }));
    expect(await screen.findByTestId('sync-tab-r2')).toBeInTheDocument();
    expect(screen.getByTestId('sync-tab-remote')).toBeInTheDocument();
    // Remote tab (default) keeps the sync preview pin
    expect(screen.getByTestId('sync-preview-pull')).toBeInTheDocument();
    await user.click(screen.getByTestId('sync-tab-r2'));
    expect(await screen.findByText(/maestro-backup/i)).toBeInTheDocument();
    expect(screen.getByTestId('r2-preview-backup')).toBeEnabled();
    await user.click(screen.getByTestId('r2-preview-backup'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('R2 tab shows Not configured and disables backup actions when no bucket is set', async () => {
    const user = userEvent.setup();
    const rpc = vi.fn(async (_ch: string, method: string) => {
      if (method === 'backupStatus') return carrier({ configured: false, source: 'none', bucket: '', prefix: '', lastManifest: null, eligible: { md: 0, sessions: 0 } });
      if (method === 'status') return carrier({ ok: true, remoteHost: 'sync-host', connection: { ok: true, host: 'sync-host' }, localOnly: 0, remoteOnly: 0, both: 0 });
      return { ok: true };
    });
    render(React.createElement(SyncPanel, { ctx: makeCtx((_ch: string, m: string) => rpc(_ch, m)) as any }));
    await user.click(screen.getByTestId('sync-tab-r2'));
    expect((await screen.findAllByText(/not configured/i)).length).toBeGreaterThan(0);
    expect(screen.getByTestId('r2-preview-backup')).toBeDisabled();
  });
});
